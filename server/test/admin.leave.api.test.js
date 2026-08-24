import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  testConfig,
  getTestPool,
  resetDb,
  closeTestPool,
} from './helpers.js';
import { createApp } from '../src/app.js';
import { hashPassword } from '../src/lib/passwords.js';

const cfg = testConfig();
const pool = await getTestPool();
const app = createApp({ config: cfg, pool });
const query = (t, v) => pool.query(t, v);

async function seedUser(role, email) {
  const hash = await hashPassword('Passw0rd!123');
  const { rows } = await query(
    `INSERT INTO users (role, email, password_hash, name) VALUES ($1,$2,$3,'T') RETURNING id`,
    [role, email, hash],
  );
  return rows[0].id;
}

let adminCookie;
let doctorId;
const LEAVE_DATE = '2026-09-04'; // a Friday

beforeAll(async () => {
  await resetDb();
  await seedUser('admin', 'admin@t.health');
  const login = await request(app).post('/api/auth/login').send({
    email: 'admin@t.health',
    password: 'Passw0rd!123',
  });
  adminCookie = login.headers['set-cookie'];

  const docUserId = await seedUser('doctor', 'leavedoc@t.health');
  await query(
    `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
     VALUES ($1,'Gen','{1,2,3,4,5}','09:00'::time,'11:00'::time,20)`,
    [docUserId],
  );
  doctorId = docUserId;
});

afterAll(closeTestPool);

async function seedConfirmed(stamp) {
  const patientId = await seedUser('patient', `p${stamp.replace(/[^0-9]/g, '')}@t.health`);
  const a = await query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, symptoms_text, severity, duration_text)
     VALUES ($1,$2,$3::timestamp,'confirmed','cough','mild','three days') RETURNING id`,
    [patientId, doctorId, stamp],
  );
  const apptId = a.rows[0].id;
  await query(
    `INSERT INTO pre_visit_summaries (appointment_id, urgency, chief_complaint, questions, generation_status)
     VALUES ($1,'low','cough','[]','ready')`,
    [apptId],
  );
  return apptId;
}

describe('leave preview + marking', () => {
  it('role gates and validation', async () => {
    await seedUser('patient', 'lp2@t.health');
    const pLogin = await request(app).post('/api/auth/login').send({
      email: 'lp2@t.health', password: 'Passw0rd!123',
    });

    await expect(
      request(app).get(`/api/admin/doctors/${doctorId}/leave-preview`).query({ date: LEAVE_DATE }),
    ).resolves.toMatchObject({ status: 401 });

    const asPatient = await request(app)
      .get(`/api/admin/doctors/${doctorId}/leave-preview`)
      .query({ date: LEAVE_DATE })
      .set('Cookie', pLogin.headers['set-cookie']);
    expect(asPatient.status).toBe(403);

    const badDate = await request(app)
      .get(`/api/admin/doctors/${doctorId}/leave-preview`)
      .query({ date: 'not-a-date' })
      .set('Cookie', adminCookie);
    expect(badDate.status).toBe(400);

    const ghost = await request(app)
      .get('/api/admin/doctors/999999/leave-preview')
      .query({ date: LEAVE_DATE })
      .set('Cookie', adminCookie);
    expect(ghost.status).toBe(404);
  });

  it('preview counts only confirmed bookings on that date', async () => {
    const keep = await seedConfirmed('2026-09-07 09:00'); // different day
    const hit = await seedConfirmed(`${LEAVE_DATE} 09:00`);
    const gone = await seedConfirmed(`${LEAVE_DATE} 10:00`);
    await query(`UPDATE appointments SET status='cancelled_by_patient' WHERE id=$1`, [gone]);

    const res = await request(app)
      .get(`/api/admin/doctors/${doctorId}/leave-preview`)
      .query({ date: LEAVE_DATE })
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ date: LEAVE_DATE, affectedCount: 1 });
    void keep; void hit;
  });

  it('marking leave atomically cancels affected bookings with audit, emails, calendar deletions', async () => {
    // Isolate this date: park leftovers from earlier tests so exactly one
    // confirmed booking remains for the cascade to pick up.
    await query(
      `UPDATE appointments SET status='cancelled_by_admin'
       WHERE scheduled_at::date=$1::date AND status='confirmed'`,
      [LEAVE_DATE],
    );
    const apptId = await seedConfirmed(`${LEAVE_DATE} 09:20`);
    await query(
      `INSERT INTO calendar_events (appointment_id, audience, google_event_id, sync_status)
       VALUES ($1,'patient','g-1','synced'), ($1,'doctor','g-2','synced')`,
      [apptId],
    );

    const res = await request(app)
      .post(`/api/admin/doctors/${doctorId}/leave`)
      .set('Cookie', adminCookie)
      .send({ date: LEAVE_DATE });
    expect(res.status).toBe(200);
    expect(res.body.cancelledCount).toBe(1);

    const appt = (await query(`SELECT * FROM appointments WHERE id=$1`, [apptId])).rows[0];
    expect(appt.status).toBe('cancelled_by_leave');

    const leaveRow = (
      await query(`SELECT * FROM leave_days WHERE doctor_id=$1 AND date=$2::date`, [
        doctorId,
        LEAVE_DATE,
      ])
    ).rows[0];
    expect(leaveRow).toBeTruthy();

    const events = (
      await query(
        `SELECT * FROM appointment_events WHERE appointment_id=$1 ORDER BY id`,
        [apptId],
      )
    ).rows.map((e) => e.reason);
    expect(events).toContain(`leave:${LEAVE_DATE}`);

    const mails = (
      await query(`SELECT * FROM email_queue WHERE appointment_id=$1 ORDER BY id`, [apptId])
    ).rows;
    expect(mails).toHaveLength(2);
    expect(mails.every((m) => m.dedup_key.startsWith(`leave:${apptId}:`))).toBe(true);

    const cals = (await query(`SELECT * FROM calendar_events WHERE appointment_id=$1`, [apptId]))
      .rows.map((c) => c.sync_status);
    expect(cals).toEqual(['deleting', 'deleting']);
  });

  it('re-marking is idempotent , no double cancellation, no duplicate emails', async () => {
    const before = (await query(`SELECT count(*)::int AS n FROM email_queue`)).rows[0].n;

    const res = await request(app)
      .post(`/api/admin/doctors/${doctorId}/leave`)
      .set('Cookie', adminCookie)
      .send({ date: LEAVE_DATE });
    expect(res.status).toBe(200);
    expect(res.body.cancelledCount).toBe(0);

    const after = (await query(`SELECT count(*)::int AS n FROM email_queue`)).rows[0].n;
    expect(after).toBe(before);
  });

  it('slots are suppressed on the leave day afterwards', async () => {
    await seedUser('patient', 'lcheck@t.health');
    const login = await request(app).post('/api/auth/login').send({
      email: 'lcheck@t.health', password: 'Passw0rd!123',
    });
    const res = await request(app)
      .get(`/api/doctors/${doctorId}/slots`)
      .query({ date: LEAVE_DATE })
      .set('Cookie', login.headers['set-cookie']);
    expect(res.status).toBe(200);
    expect(res.body.slots).toHaveLength(0);

    // A different working day remains open.
    const ok = await request(app)
      .get(`/api/doctors/${doctorId}/slots`)
      .query({ date: '2026-09-07' })
      .set('Cookie', login.headers['set-cookie']);
    expect(ok.body.slots.length).toBeGreaterThan(0);
  });
});
