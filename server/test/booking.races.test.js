import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';
import { clinicNowStr } from '../src/routes/public.routes.js';
import { expireHolds } from '../src/services/workers/hold.sweeper.js';

// Isolated suite database , deliberately NOT helpers.js (that one is pinned to
// hcm_test, which another suite uses concurrently). AGENT_DB_URL can redirect.
const DB_URL =
  process.env.AGENT_DB_URL ??
  'postgres://postgres:postgres@localhost:5432/hcm_agent_b';

const config = loadConfig({
  DATABASE_URL: DB_URL,
  JWT_SECRET: 'test-jwt-secret-not-for-production',
  JOB_SECRET: 'test-job-secret',
});
const pool = getPool(config);
await runMigrations(pool, migrationsDir);
const query = (t, v) => pool.query(t, v);

async function resetDb() {
  await query(`
    TRUNCATE appointment_events, calendar_events, notification_log,
             email_queue, post_visit_summaries, visit_notes,
             pre_visit_summaries, appointments, leave_days, doctors, users
    RESTART IDENTITY CASCADE
  `);
}

let NOW = new Date('2026-08-20T08:00:00');
const BASE_NOW = new Date(NOW);
const tickMinutes = (min) => {
  NOW = new Date(BASE_NOW.getTime() + min * 60_000);
};

const app = createApp({
  config,
  pool,
  now: () => NOW,
  nowStr: () => clinicNowStr(NOW),
});

const cookie = (id, role) =>
  `hcm_session=${jwt.sign({ sub: String(id), role }, config.jwtSecret)}`;

const MONDAY = '2026-08-24';
const NEXT_MONDAY = '2026-08-31';
const SYMPTOMS = {
  symptomsText: 'Persistent dry cough for five days, worse at night.',
  severity: 'moderate',
  durationText: '5 days',
};

let seq = 9000;
const tag = () => (seq += 1);

async function mkDoctor(t = tag()) {
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminC)
    .send({
      email: `race.doc.${t}@ashgrove.health`, name: `Dr. ${t}`, password: 'doctor-pass-1',
      specialisation: 'General Medicine', workingDays: [1],
      startsAt: '09:00', endsAt: '11:00', slotMinutes: 20,
    });
  expect(res.status).toBe(201);
  return res.body.doctor;
}

async function mkPatient(t = tag()) {
  const res = await request(app).post('/api/auth/register').send({
    email: `race.pat.${t}@ashgrove.health`, name: `P ${t}`, password: 'long-enough-1',
  });
  expect(res.status).toBe(201);
  return { id: res.body.user.id, c: cookie(res.body.user.id, 'patient') };
}

async function hold(p, doc, time, date = MONDAY) {
  return request(app)
    .post(`/api/doctors/${doc.userId}/slots/hold`)
    .set('Cookie', p.c)
    .send({ scheduledAt: `${date} ${time}` });
}

async function confirmAppt(p, appointmentId, payload = SYMPTOMS) {
  return request(app)
    .post(`/api/appointments/${appointmentId}/confirm`)
    .set('Cookie', p.c)
    .send(payload);
}

async function heldAppointment(doc, time = '09:00', t = tag(), date = MONDAY) {
  const p = await mkPatient(t);
  const h = await hold(p, doc, time, date);
  expect(h.status).toBe(201);
  return { p, id: h.body.appointment.id };
}

let adminC;

beforeAll(async () => {
  await resetDb();
  adminC = cookie(999, 'admin');
});

afterAll(async () => {
  await pool.end();
});

describe('race: N patients race for the same open slot', () => {
  it('12 parallel holds → exactly one 201, eleven SLOT_TAKEN, zero double-bookings', async () => {
    const doc = await mkDoctor();
    const patients = [];
    for (let i = 0; i < 12; i += 1) patients.push(await mkPatient());

    const results = await Promise.all(
      patients.map((p) =>
        request(app)
          .post(`/api/doctors/${doc.userId}/slots/hold`)
          .set('Cookie', p.c)
          .send({ scheduledAt: `${MONDAY} 09:00` }),
      ),
    );

    const created = results.filter((r) => r.status === 201);
    const taken = results.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_TAKEN');
    expect(created).toHaveLength(1);
    expect(taken).toHaveLength(11);

    // Zero double-bookings: exactly one live row for that doctor+slot, and no
    // stray rows of any status beyond the single winner.
    const rows = await query(
      `SELECT patient_id, status FROM appointments WHERE doctor_id = $1 AND scheduled_at = $2::timestamp`,
      [doc.userId, `${MONDAY} 09:00`],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('held');

    const winnerId = created[0].body.appointment.id;
    const winnerRow = await query(`SELECT patient_id FROM appointments WHERE id = $1`, [winnerId]);
    expect(rows.rows[0].patient_id).toBe(winnerRow.rows[0].patient_id);

    // The loser set is left with nothing at all for this slot.
    const totalForDoctor = await query(
      `SELECT count(*)::int n FROM appointments WHERE doctor_id = $1`,
      [doc.userId],
    );
    expect(totalForDoctor.rows[0].n).toBe(1);
  });

  it('12 parallel holds then exactly one confirmation chain keeps a single live appointment', async () => {
    const doc = await mkDoctor();
    const patients = [];
    for (let i = 0; i < 12; i += 1) patients.push(await mkPatient());

    const holds = await Promise.all(
      patients.map((p) =>
        request(app)
          .post(`/api/doctors/${doc.userId}/slots/hold`)
          .set('Cookie', p.c)
          .send({ scheduledAt: `${MONDAY} 09:20` }),
      ),
    );
    const winners = patients.filter((_, i) => holds[i].status === 201);
    expect(winners).toHaveLength(1);
    const winnerId = holds.find((r) => r.status === 201).body.appointment.id;

    const conf = await confirmAppt(winners[0], winnerId);
    expect(conf.status).toBe(200);

    const rows = await query(
      `SELECT status FROM appointments WHERE doctor_id = $1`,
      [doc.userId],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('confirmed');
  });
});

describe('race: duplicate simultaneous confirms by the same patient', () => {
  it('6 parallel confirms of one hold → exactly one success, side effects enqueued once', async () => {
    const doc = await mkDoctor();
    const { p, id } = await heldAppointment(doc, '09:00');

    const results = await Promise.all(
      Array.from({ length: 6 }, () => confirmAppt(p, id)),
    );

    const ok = results.filter((r) => r.status === 200);
    const rejected = results.filter((r) => r.status >= 400);
    expect(ok).toHaveLength(1);
    expect(rejected).toHaveLength(5);
    for (const r of rejected) {
      expect([409, 410]).toContain(r.status); // CONFLICT (already confirmed / not held) or HOLD_EXPIRED
    }

    const rows = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].status).toBe('confirmed');

    const emails = await query(
      `SELECT count(*)::int n FROM email_queue WHERE appointment_id = $1 AND template = 'booking_confirmation'`,
      [id],
    );
    expect(emails.rows[0].n).toBe(2); // patient + doctor, deduped

    const cals = await query(
      `SELECT count(*)::int n FROM calendar_events WHERE appointment_id = $1`,
      [id],
    );
    expect(cals.rows[0].n).toBe(2);

    const summaries = await query(
      `SELECT count(*)::int n FROM pre_visit_summaries WHERE appointment_id = $1`,
      [id],
    );
    expect(summaries.rows[0].n).toBe(1);
  });
});

describe('race: hold expiry vs another patient booking the same instant', () => {
  it('expired hold never blocks forever: sweeper + competing hold settle to a consistent state', async () => {
    const doc = await mkDoctor();
    const p1 = await mkPatient();
    const staleHold = await hold(p1, doc, '09:40');
    expect(staleHold.status).toBe(201);
    const staleId = staleHold.body.appointment.id;

    tickMinutes(6); // p1's hold is now past expiry but not yet swept

    const p2 = await mkPatient();
    const [sweep, p2Attempt] = await Promise.all([
      expireHolds({ pool, now: () => NOW }),
      hold(p2, doc, '09:40'),
    ]);

    if (p2Attempt.status === 201) {
      // Sweeper won the race before p2's insert , slot was already free.
      expect(sweep.expired).toBeGreaterThanOrEqual(1);
    } else {
      // p2's unique-index attempt landed before the sweep flipped the row.
      expect(p2Attempt.status).toBe(409);
      expect(p2Attempt.body.error.code).toBe('SLOT_TAKEN');
    }

    // Either way the ghost cannot survive: sweeping frees it deterministically.
    await expireHolds({ pool, now: () => NOW });
    const staleRow = await query(`SELECT status FROM appointments WHERE id = $1`, [staleId]);
    expect(staleRow.rows[0].status).toBe('expired');

    if (p2Attempt.status !== 201) {
      // p2 lost the parallel attempt to the unswept ghost; now that the sweep
      // has flipped it, a retry must go through.
      const retry = await hold(p2, doc, '09:40');
      expect(retry.status).toBe(201);
    }
    // else: p2 already won the slot during the race itself , no retry needed.

    // Exactly one live hold on the slot, owned by p2.
    const rows = await query(
      `SELECT patient_id, status FROM appointments
       WHERE doctor_id = $1 AND scheduled_at = $2::timestamp AND status IN ('held','confirmed')`,
      [doc.userId, `${MONDAY} 09:40`],
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0]).toMatchObject({ patient_id: p2.id, status: 'held' });

    // The expired holder can no longer sneak a confirm through.
    const lateConfirm = await confirmAppt(p1, staleId);
    expect(lateConfirm.status).toBeGreaterThanOrEqual(400);
  });
});

describe('race: admin marks leave while a patient confirms on that date', () => {
  it('deterministic interleaving: leave committed while slot still held → later confirm must be rejected', async () => {
    // This pins the invariant end-state: leave lands while the booking is only
    // HELD (markLeave only cascades confirmed rows), then the patient confirms.
    const doc = await mkDoctor();
    const { p, id } = await heldAppointment(doc, '09:00');

    const leave = await request(app)
      .post(`/api/admin/doctors/${doc.userId}/leave`)
      .set('Cookie', adminC)
      .send({ date: MONDAY });
    expect(leave.status).toBe(200);
    expect(leave.body.cancelledCount).toBe(0); // nothing confirmed yet to cascade

    const conf = await confirmAppt(p, id);
    // A confirmed appointment must never come to rest on a leave day.
    expect(conf.status).toBeGreaterThanOrEqual(400);

    const row = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(row.rows[0].status).not.toBe('confirmed');
  });

  it('true parallel race over fresh doctors → either confirm rejected or leave cascade cancels it', async () => {
    const ROUNDS = 5;
    for (let round = 0; round < ROUNDS; round += 1) {
      const doc = await mkDoctor();
      const { p, id } = await heldAppointment(doc, '10:00', undefined, NEXT_MONDAY);

      const [confirmRes] = await Promise.all([
        confirmAppt(p, id),
        request(app)
          .post(`/api/admin/doctors/${doc.userId}/leave`)
          .set('Cookie', adminC)
          .send({ date: NEXT_MONDAY }),
      ]);

      const final = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
      const status = final.rows[0].status;

      if (confirmRes.status === 200) {
        // Confirm beat the leave UPDATE → the cascade must have caught it.
        expect(status).toBe('cancelled_by_leave');
        const mails = await query(
          `SELECT template FROM email_queue WHERE appointment_id = $1 AND template = 'leave_cancellation'`,
          [id],
        );
        expect(mails.rowCount).toBe(2);
      } else {
        // Confirm was blocked outright (e.g., leave-day guard under the row lock).
        expect(confirmRes.status).toBeGreaterThanOrEqual(400);
        expect(['held', 'cancelled_by_leave']).toContain(status);
      }

      // Core invariant in both branches: no confirmed appointment remains on the leave date.
      const confirmedOnLeave = await query(
        `SELECT count(*)::int n FROM appointments
         WHERE doctor_id = $1 AND status = 'confirmed'
           AND scheduled_at >= $2::date AND scheduled_at < ($2::date + INTERVAL '1 day')`,
        [doc.userId, NEXT_MONDAY],
      );
      expect(confirmedOnLeave.rows[0].n).toBe(0);
    }
  });
});

describe('race: cancel vs reschedule on the same appointment', () => {
  it('parallel DELETE + PATCH → single winner, coherent end state, no stray rows', async () => {
    const doc = await mkDoctor();
    const { p, id } = await heldAppointment(doc, '09:00');
    const conf = await confirmAppt(p, id);
    expect(conf.status).toBe(200);

    const [cancelRes, reschedRes] = await Promise.all([
      request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c),
      request(app)
        .patch(`/api/appointments/${id}/reschedule`)
        .set('Cookie', p.c)
        .send({ newScheduledAt: `${MONDAY} 09:20` }),
    ]);

    const twoHundreds = [cancelRes, reschedRes].filter((r) => r.status < 300);
    expect(twoHundreds).toHaveLength(1);

    const allRows = await query(
      `SELECT id, status, to_char(scheduled_at, 'YYYY-MM-DD HH24:MI') AS stamp
       FROM appointments WHERE doctor_id = $1 ORDER BY scheduled_at`,
      [doc.userId],
    );

    if (cancelRes.status === 200) {
      expect(cancelRes.body.appointment.status).toBe('cancelled_by_patient');
      expect(reschedRes.status).toBe(409);
      expect(reschedRes.body.error.code).toBe('CONFLICT');

      // Cancel won: original cancelled, no shadow row at the target time.
      expect(allRows.rows).toHaveLength(1);
      expect(allRows.rows[0]).toMatchObject({ id, status: 'cancelled_by_patient' });
    } else {
      expect(reschedRes.status).toBe(200);
      expect(cancelRes.status).toBe(409);
      expect(cancelRes.body.error.code).toBe('CONFLICT');

      // Reschedule won: old row rescheduled, new row confirmed at the new time.
      expect(allRows.rows).toHaveLength(2);
      const statuses = allRows.rows.map((r) => r.status).sort();
      expect(statuses).toEqual(['confirmed', 'rescheduled']);
      const moved = allRows.rows.find((r) => r.status === 'confirmed');
      expect(moved.stamp).toBe(`${MONDAY} 09:20`);
      expect(reschedRes.body.previous).toMatchObject({ id, status: 'rescheduled' });
    }
  });
});
