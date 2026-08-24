import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import {
  testConfig,
  getTestPool,
  resetDb,
  closeTestPool,
} from './helpers.js';
import { createApp } from '../src/app.js';

const cfg = testConfig();
const pool = await getTestPool();
const app = createApp({ config: cfg, pool });
const query = (t, v) => pool.query(t, v);

afterAll(closeTestPool);

let doctorCookie;
let otherDoctorCookie;
let patientCookie;

async function loginAs(role, email) {
  const hashMod = await import('../src/lib/passwords.js');
  const hash = await hashMod.hashPassword('Passw0rd!123');
  await query(
    `INSERT INTO users (role, email, password_hash, name) VALUES ($1,$2,$3,'T')
     ON CONFLICT (email) DO UPDATE SET password_hash = EXCLUDED.password_hash`,
    [role, email, hash],
  );
  const res = await request(app).post('/api/auth/login').send({ email, password: 'Passw0rd!123' });
  return res.headers['set-cookie'];
}

async function seedConfirmedAppt(stamp) {
  const p = await query(
    `INSERT INTO users (role,email,password_hash,name) VALUES ('patient', $1,'x','P') RETURNING id`,
    [`vp${Date.now()}${Math.floor(Math.random() * 1e6)}@t.health`],
  );
  const dU = await query(
    `INSERT INTO users (role,email,password_hash,name) VALUES ('doctor', $1,'x','D') RETURNING id`,
    [`vd${Date.now()}${Math.floor(Math.random() * 1e6)}@t.health`],
  );
  await query(
    `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
     VALUES ($1,'Gen','{1,2,3,4,5}','09:00'::time,'17:00'::time,30)`,
    [dU.rows[0].id],
  );
  const a = await query(
    `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, symptoms_text, severity, duration_text)
     VALUES ($1,$2,$3::timestamp,'confirmed','headache','moderate','two days') RETURNING id`,
    [p.rows[0].id, dU.rows[0].id, stamp],
  );
  await query(
    `INSERT INTO pre_visit_summaries (appointment_id, urgency, chief_complaint, questions, generation_status)
     VALUES ($1,'medium','headache','[]','ready')`,
    [a.rows[0].id],
  );
  return { apptId: a.rows[0].id, doctorUserId: dU.rows[0].id };
}

beforeAll(async () => {
  await resetDb();
  doctorCookie = await loginAs('doctor', 'notesdoc@t.health');
  otherDoctorCookie = await loginAs('doctor', 'otherdoc@t.health');
  patientCookie = await loginAs('patient', 'notespat@t.health');

  for (const email of ['notesdoc@t.health', 'otherdoc@t.health']) {
    const { rows } = await query(`SELECT id FROM users WHERE email=$1`, [email]);
    await query(
      `INSERT INTO doctors (user_id, specialisation, working_days, starts_at, ends_at, slot_minutes)
       VALUES ($1,'Gen','{1,2,3,4,5}','09:00'::time,'17:00'::time,30)
       ON CONFLICT (user_id) DO NOTHING`,
      [rows[0].id],
    );
  }
});

describe('POST /api/appointments/:id/notes', () => {
  it('records notes + prescription atomically: visit_notes row, completed status, pending post-visit summary, audit event', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-24 09:00');
    // Transfer ownership to the logged-in doctor.
    const myId = (await query(`SELECT id FROM users WHERE email='notesdoc@t.health'`)).rows[0].id;
    await query(`UPDATE appointments SET doctor_id=$2 WHERE id=$1`, [apptId, myId]);

    const res = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({
        clinicalNotes: 'Tension headache. No red flags.',
        prescription: [
          { name: 'Paracetamol', dosage: '500mg', times: ['08:00', '20:00'], durationDays: 5 },
        ],
      });
    expect(res.status).toBe(200);

    const notes = (await query(`SELECT * FROM visit_notes WHERE appointment_id=$1`, [apptId])).rows[0];
    expect(notes.clinical_notes).toContain('Tension headache');
    expect(notes.prescription[0]).toMatchObject({ name: 'Paracetamol', durationDays: 5 });
    expect(notes.prescription[0].times).toEqual(['08:00', '20:00']);

    const appt = (await query(`SELECT status FROM appointments WHERE id=$1`, [apptId])).rows[0];
    expect(appt.status).toBe('completed');

    const post = (
      await query(`SELECT generation_status FROM post_visit_summaries WHERE appointment_id=$1`, [apptId])
    ).rows[0];
    expect(post.generation_status).toBe('pending');

    const ev = (
      await query(`SELECT * FROM appointment_events WHERE appointment_id=$1 ORDER BY id DESC LIMIT 1`, [apptId])
    ).rows[0];
    expect(ev.to_status).toBe('completed');
    expect(ev.reason).toBe('visit_recorded');
  });

  it('validates payload: missing notes and malformed prescriptions are rejected with field lists', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-24 10:00');
    const myId = (await query(`SELECT id FROM users WHERE email='notesdoc@t.health'`)).rows[0].id;
    await query(`UPDATE appointments SET doctor_id=$2 WHERE id=$1`, [apptId, myId]);

    const missing = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({ prescription: [] });
    expect(missing.status).toBe(400);
    expect(missing.body.error.code).toBe('VALIDATION_ERROR');
    expect(JSON.stringify(missing.body.error.message)).toContain('clinicalNotes');

    const badTime = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({
        clinicalNotes: 'ok',
        prescription: [{ name: '', dosage: 'x', times: ['25:99'], durationDays: 0 }],
      });
    expect(badTime.status).toBe(400);
  });

  it('another doctor cannot record notes on someone else’s appointment (404)', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-25 09:00');

    const res = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', otherDoctorCookie)
      .send({ clinicalNotes: 'sneaky' });
    expect(res.status).toBe(404);

    const n = (await query(`SELECT count(*)::int AS n FROM visit_notes WHERE appointment_id=$1`, [apptId])).rows[0].n;
    expect(n).toBe(0);
  });

  it('patients cannot reach the endpoint (403)', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-25 10:00');
    const res = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', patientCookie)
      .send({ clinicalNotes: 'self diagnosis' });
    expect([401, 403]).toContain(res.status);
  });

  it('non-confirmed appointments cannot be closed (409)', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-26 09:00');
    const myId = (await query(`SELECT id FROM users WHERE email='notesdoc@t.health'`)).rows[0].id;
    await query(`UPDATE appointments SET doctor_id=$2, status='cancelled_by_patient' WHERE id=$1`, [
      apptId,
      myId,
    ]);

    const res = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({ clinicalNotes: 'late entry' });
    expect(res.status).toBe(409);
  });

  it('first write wins , re-recording is a 409 and does not touch the pending summary', async () => {
    const { apptId } = await seedConfirmedAppt('2026-08-27 09:00');
    const myId = (await query(`SELECT id FROM users WHERE email='notesdoc@t.health'`)).rows[0].id;
    await query(`UPDATE appointments SET doctor_id=$2 WHERE id=$1`, [apptId, myId]);

    const first = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({ clinicalNotes: 'v1', prescription: [] });
    expect(first.status).toBe(200);

    const again = await request(app)
      .post(`/api/appointments/${apptId}/notes`)
      .set('Cookie', doctorCookie)
      .send({ clinicalNotes: 'v2' });
    expect(again.status).toBe(409);
    expect((await query(`SELECT clinical_notes FROM visit_notes WHERE appointment_id=$1`, [apptId])).rows[0].clinical_notes).toBe('v1');

    const pendings = (
      await query(`SELECT count(*)::int AS n FROM post_visit_summaries WHERE appointment_id=$1`, [apptId])
    ).rows[0].n;
    expect(pendings).toBe(1);
  });

  it('unknown appointment id → 404', async () => {
    const res = await request(app)
      .post('/api/appointments/00000000-0000-0000-0000-000000000000/notes')
      .set('Cookie', doctorCookie)
      .send({ clinicalNotes: 'x' });
    expect(res.status).toBe(404);
  });
});
