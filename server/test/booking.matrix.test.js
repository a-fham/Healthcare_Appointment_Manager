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
const TUESDAY = '2026-08-25';
const SYMPTOMS = {
  symptomsText: 'Lower back pain radiating down the left leg.',
  severity: 'moderate',
  durationText: '2 weeks',
};

let seq = 4000;
const tag = () => (seq += 1);

async function mkDoctor(t = tag()) {
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminC)
    .send({
      email: `mx.doc.${t}@ashgrove.health`, name: `Dr. ${t}`, password: 'doctor-pass-1',
      specialisation: 'General Medicine', workingDays: [1],
      startsAt: '09:00', endsAt: '11:00', slotMinutes: 20,
    });
  expect(res.status).toBe(201);
  return res.body.doctor;
}

async function mkPatient(t = tag()) {
  const res = await request(app).post('/api/auth/register').send({
    email: `mx.pat.${t}@ashgrove.health`, name: `P ${t}`, password: 'long-enough-1',
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

async function confirmHeld(p, appointmentId, payload = SYMPTOMS) {
  return request(app)
    .post(`/api/appointments/${appointmentId}/confirm`)
    .set('Cookie', p.c)
    .send(payload);
}

async function confirmedAppt(time = '09:00', doc = null, t = tag()) {
  const d = doc ?? (await mkDoctor(t));
  const p = await mkPatient(t);
  const h = await hold(p, d, time);
  expect(h.status).toBe(201);
  const conf = await confirmHeld(p, h.body.appointment.id);
  expect(conf.status).toBe(200);
  return { doc: d, p, holdId: h.body.appointment.id, id: conf.body.appointment.id };
}

function doctorCookie(doc) {
  return cookie(doc.userId, 'doctor');
}

async function apptStatus(id) {
  const { rows } = await query(`SELECT status FROM appointments WHERE id = $1`, [id]);
  return rows.length === 0 ? null : rows[0].status;
}

beforeAll(async () => {
  await resetDb();
});

afterAll(async () => {
  await pool.end();
});

let adminC;
// admin user id 999 never needs a DB row: cancel-as-admin matches on role only.
beforeAll(() => {
  adminC = cookie(999, 'admin');
});

describe('legal transitions persist (derived from booking/notes/leave services)', () => {
  it('NULL→held→confirmed via symptom submit: status + symptoms + audit row persist', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '09:00');
    expect(h.status).toBe(201);

    const conf = await confirmHeld(p, h.body.appointment.id);
    expect(conf.status).toBe(200);
    expect(conf.body.appointment.status).toBe('confirmed');

    const row = (
      await query(
        `SELECT status, symptoms_text, severity, duration_text FROM appointments WHERE id = $1`,
        [h.body.appointment.id],
      )
    ).rows[0];
    expect(row).toMatchObject({
      status: 'confirmed',
      symptoms_text: SYMPTOMS.symptomsText,
      severity: 'moderate',
      duration_text: SYMPTOMS.durationText,
    });

    const evt = (
      await query(
        `SELECT from_status, to_status, actor_role FROM appointment_events
         WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1`,
        [h.body.appointment.id],
      )
    ).rows[0];
    expect(evt).toMatchObject({ from_status: 'held', to_status: 'confirmed', actor_role: 'patient' });
  });

  it('confirmed→cancelled_by_patient persists', async () => {
    const { p, id } = await confirmedAppt('09:00');
    const res = await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    expect(res.status).toBe(200);
    expect(await apptStatus(id)).toBe('cancelled_by_patient');
  });

  it('confirmed→cancelled_by_admin persists with admin audit actor', async () => {
    const { id } = await confirmedAppt('09:20');
    const res = await request(app).delete(`/api/appointments/${id}`).set('Cookie', adminC);
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('cancelled_by_admin');
    expect(await apptStatus(id)).toBe('cancelled_by_admin');

    const evt = (
      await query(
        `SELECT actor_role FROM appointment_events WHERE appointment_id = $1 AND to_status = 'cancelled_by_admin'`,
        [id],
      )
    ).rows[0];
    expect(evt.actor_role).toBe('admin');
  });

  it('held→cancelled_by_patient is legal; no cancellation emails, no calendar rows, slot freed', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '09:40');

    const res = await request(app).delete(`/api/appointments/${h.body.appointment.id}`).set('Cookie', p.c);
    expect(res.status).toBe(200);
    expect(await apptStatus(h.body.appointment.id)).toBe('cancelled_by_patient');

    expect(
      (await query(`SELECT count(*)::int n FROM email_queue WHERE appointment_id = $1`, [h.body.appointment.id])).rows[0].n,
    ).toBe(0);
    expect(
      (await query(`SELECT count(*)::int n FROM calendar_events WHERE appointment_id = $1`, [h.body.appointment.id])).rows[0].n,
    ).toBe(0);

    const other = await mkPatient();
    expect((await hold(other, doc, '09:40')).status).toBe(201);
  });

  it('confirmed→completed via doctor visit notes persists', async () => {
    const { doc, id } = await confirmedAppt('10:00');
    const res = await request(app)
      .post(`/api/appointments/${id}/notes`)
      .set('Cookie', doctorCookie(doc))
      .send({
        clinicalNotes: 'Mechanical back pain. No red flags.',
        prescription: [{ name: 'Ibuprofen', dosage: '400mg', times: ['08:00', '20:00'], durationDays: 5 }],
      });
    expect(res.status).toBe(200);
    expect(await apptStatus(id)).toBe('completed');

    const notes = (await query(`SELECT clinical_notes FROM visit_notes WHERE appointment_id = $1`, [id])).rows[0];
    expect(notes.clinical_notes).toContain('Mechanical back pain');
  });

  it('held→expired via sweeper on advanced injected clock persists with system audit', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '10:40');
    tickMinutes(6); // past the 5-minute expiry

    const sweep = await expireHolds({ pool, now: () => NOW });
    expect(sweep.expired).toBeGreaterThanOrEqual(1);
    expect(await apptStatus(h.body.appointment.id)).toBe('expired');

    const evt = (
      await query(
        `SELECT from_status, to_status, actor_role, reason FROM appointment_events
         WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1`,
        [h.body.appointment.id],
      )
    ).rows[0];
    expect(evt).toMatchObject({ from_status: 'held', to_status: 'expired', actor_role: 'system', reason: 'hold_expired' });

    // Slot is free again for everyone after expiry.
    const p2 = await mkPatient();
    expect((await hold(p2, doc, '10:40')).status).toBe(201);
    tickMinutes(0);
  });
});

describe('illegal transitions are rejected and leave status unchanged', () => {
  it('cancelling an already-cancelled appointment → 409 CONFLICT', async () => {
    const { p, id } = await confirmedAppt('09:00');
    await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    const again = await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
    expect(await apptStatus(id)).toBe('cancelled_by_patient');
  });

  it('re-cancelling an admin-cancelled appointment → 409 CONFLICT', async () => {
    const { p, id } = await confirmedAppt('09:20');
    await request(app).delete(`/api/appointments/${id}`).set('Cookie', adminC);
    const again = await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });

  it('confirming a cancelled appointment → 409 CONFLICT, status unchanged', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '09:40');
    await request(app).delete(`/api/appointments/${h.body.appointment.id}`).set('Cookie', p.c);

    const conf = await confirmHeld(p, h.body.appointment.id);
    expect(conf.status).toBe(409);
    expect(conf.body.error.code).toBe('CONFLICT');
    expect(await apptStatus(h.body.appointment.id)).toBe('cancelled_by_patient');
  });

  it('confirming a completed appointment → 409 CONFLICT', async () => {
    const { doc, p, holdId, id } = await confirmedAppt('10:00');
    await request(app)
      .post(`/api/appointments/${id}/notes`)
      .set('Cookie', doctorCookie(doc))
      .send({ clinicalNotes: 'done' });

    const conf = await confirmHeld(p, holdId);
    expect(conf.status).toBe(409);
    expect(conf.body.error.code).toBe('CONFLICT');
  });

  it('confirming an expired hold → 410 HOLD_EXPIRED', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '09:00');
    await query(`UPDATE appointments SET hold_expires_at = $2::timestamptz WHERE id = $1`, [
      h.body.appointment.id,
      new Date(NOW.getTime() - 60_000),
    ]);

    const conf = await confirmHeld(p, h.body.appointment.id);
    expect(conf.status).toBe(410);
    expect(conf.body.error.code).toBe('HOLD_EXPIRED');
    expect(await apptStatus(h.body.appointment.id)).toBe('held'); // sweeper expires later
  });

  it('rescheduling a held (not yet confirmed) appointment → 409 CONFLICT', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '09:00');

    const res = await request(app)
      .patch(`/api/appointments/${h.body.appointment.id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: `${MONDAY} 09:20` });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('CONFLICT');
    expect(await apptStatus(h.body.appointment.id)).toBe('held');
  });

  it('rescheduling a cancelled / completed / already-rescheduled appointment → 409 CONFLICT', async () => {
    const doc = await mkDoctor();

    const cancelled = await confirmedAppt('09:00', doc);
    await request(app).delete(`/api/appointments/${cancelled.id}`).set('Cookie', cancelled.p.c);
    const r1 = await request(app)
      .patch(`/api/appointments/${cancelled.id}/reschedule`)
      .set('Cookie', cancelled.p.c)
      .send({ newScheduledAt: `${MONDAY} 09:20` });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('CONFLICT');

    const completed = await confirmedAppt('09:40', doc);
    await request(app)
      .post(`/api/appointments/${completed.id}/notes`)
      .set('Cookie', doctorCookie(doc))
      .send({ clinicalNotes: 'ok' });
    const r2 = await request(app)
      .patch(`/api/appointments/${completed.id}/reschedule`)
      .set('Cookie', completed.p.c)
      .send({ newScheduledAt: `${MONDAY} 10:00` });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('CONFLICT');

    const mover = await confirmedAppt('10:20', doc);
    const moved = await request(app)
      .patch(`/api/appointments/${mover.id}/reschedule`)
      .set('Cookie', mover.p.c)
      .send({ newScheduledAt: `${MONDAY} 10:40` });
    expect(moved.status).toBe(200);
    // The stale pre-reschedule id cannot be rescheduled a second time.
    const r3 = await request(app)
      .patch(`/api/appointments/${mover.id}/reschedule`)
      .set('Cookie', mover.p.c)
      .send({ newScheduledAt: `${MONDAY} 09:00` });
    expect(r3.status).toBe(409);
    expect(r3.body.error.code).toBe('CONFLICT');
  });

  it('completing without visit notes → 400 VALIDATION_ERROR, stays confirmed', async () => {
    const { doc, id } = await confirmedAppt('09:00');
    const res = await request(app)
      .post(`/api/appointments/${id}/notes`)
      .set('Cookie', doctorCookie(doc))
      .send({ prescription: [] });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(await apptStatus(id)).toBe('confirmed');
  });

  it('completing a cancelled or held appointment → 409 CONFLICT', async () => {
    const doc = await mkDoctor();
    const dc = doctorCookie(doc);

    const cancelled = await confirmedAppt('09:00', doc);
    await request(app).delete(`/api/appointments/${cancelled.id}`).set('Cookie', cancelled.p.c);
    const r1 = await request(app)
      .post(`/api/appointments/${cancelled.id}/notes`)
      .set('Cookie', dc)
      .send({ clinicalNotes: 'too late' });
    expect(r1.status).toBe(409);
    expect(r1.body.error.code).toBe('CONFLICT');

    const heldP = await mkPatient();
    const h = await hold(heldP, doc, '09:20');
    const r2 = await request(app)
      .post(`/api/appointments/${h.body.appointment.id}/notes`)
      .set('Cookie', dc)
      .send({ clinicalNotes: 'never seen' });
    expect(r2.status).toBe(409);
    expect(r2.body.error.code).toBe('CONFLICT');
    expect(await apptStatus(h.body.appointment.id)).toBe('held');
  });

  it("acting on another patient's appointment id is invisible (404): cancel, confirm, reschedule", async () => {
    const doc = await mkDoctor();
    const { p, id } = await confirmedAppt('09:00', doc);
    const stranger = await mkPatient();

    const c = await request(app).delete(`/api/appointments/${id}`).set('Cookie', stranger.c);
    expect(c.status).toBe(404);
    expect(c.body.error.code).toBe('NOT_FOUND');

    const f = await confirmHeld(stranger, id);
    expect(f.status).toBe(404);
    expect(f.body.error.code).toBe('NOT_FOUND');

    const r = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', stranger.c)
      .send({ newScheduledAt: `${MONDAY} 09:20` });
    expect(r.status).toBe(404);
    expect(r.body.error.code).toBe('NOT_FOUND');

    expect(await apptStatus(id)).toBe('confirmed');
  });
});

describe('cross-role guards (401/403)', () => {
  it('patient hitting doctor-only POST /appointments/:id/notes → 403 FORBIDDEN', async () => {
    const { p, id } = await confirmedAppt('09:00');
    const res = await request(app)
      .post(`/api/appointments/${id}/notes`)
      .set('Cookie', p.c)
      .send({ clinicalNotes: 'self-prescribed' });
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
    expect(await apptStatus(id)).toBe('confirmed');
  });

  it('patient hitting admin-only leave endpoints → 403 FORBIDDEN', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const preview = await request(app)
      .get(`/api/admin/doctors/${doc.userId}/leave-preview`)
      .set('Cookie', p.c)
      .query({ date: MONDAY });
    expect(preview.status).toBe(403);
    expect(preview.body.error.code).toBe('FORBIDDEN');

    const mark = await request(app)
      .post(`/api/admin/doctors/${doc.userId}/leave`)
      .set('Cookie', p.c)
      .send({ date: MONDAY });
    expect(mark.status).toBe(403);
    expect(mark.body.error.code).toBe('FORBIDDEN');
  });

  it('doctor hitting patient-only booking endpoints (hold/confirm/cancel/reschedule) → 403 FORBIDDEN', async () => {
    const docA = await mkDoctor();
    const { doc, p, id } = await confirmedAppt('09:00', docA);
    const dc = doctorCookie(doc);

    const h = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', dc)
      .send({ scheduledAt: `${MONDAY} 09:20` });
    expect(h.status).toBe(403);
    expect(h.body.error.code).toBe('FORBIDDEN');

    const f = await request(app)
      .post(`/api/appointments/${id}/confirm`)
      .set('Cookie', dc)
      .send(SYMPTOMS);
    expect(f.status).toBe(403);
    expect(f.body.error.code).toBe('FORBIDDEN');

    const c = await request(app).delete(`/api/appointments/${id}`).set('Cookie', dc);
    expect(c.status).toBe(403);
    expect(c.body.error.code).toBe('FORBIDDEN');

    const r = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', dc)
      .send({ newScheduledAt: `${MONDAY} 09:40` });
    expect(r.status).toBe(403);
    expect(r.body.error.code).toBe('FORBIDDEN');

    expect(await apptStatus(id)).toBe('confirmed');
  });

  it('unauthenticated requests to every transition endpoint → 401 UNAUTHORIZED', async () => {
    const { doc, id } = await confirmedAppt('09:00');

    const h = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .send({ scheduledAt: `${MONDAY} 09:20` });
    expect(h.status).toBe(401);

    const f = await request(app).post(`/api/appointments/${id}/confirm`).send(SYMPTOMS);
    expect(f.status).toBe(401);

    const c = await request(app).delete(`/api/appointments/${id}`);
    expect(c.status).toBe(401);

    const r = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .send({ newScheduledAt: `${MONDAY} 09:40` });
    expect(r.status).toBe(401);

    const n = await request(app).post(`/api/appointments/${id}/notes`).send({ clinicalNotes: 'x' });
    expect(n.status).toBe(401);

    expect(await apptStatus(id)).toBe('confirmed');
  });
});

describe('cancel frees the slot', () => {
  it('after patient cancellation the listing shows open and another patient can hold', async () => {
    const doc = await mkDoctor();
    const { p, id } = await confirmedAppt('09:20', doc);

    await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);

    const listing = await request(app)
      .get(`/api/doctors/${doc.userId}/slots`)
      .query({ date: MONDAY });
    expect(listing.status).toBe(200);
    const slot = listing.body.slots.find((s) => s.startsAt === '09:20');
    expect(slot.status).toBe('open');

    const other = await mkPatient();
    expect((await hold(other, doc, '09:20')).status).toBe(201);
  });

  it('after admin cancellation the slot is bookable again', async () => {
    const doc = await mkDoctor();
    const { id } = await confirmedAppt('09:40', doc);
    await request(app).delete(`/api/appointments/${id}`).set('Cookie', adminC);

    const other = await mkPatient();
    expect((await hold(other, doc, '09:40')).status).toBe(201);
  });
});

describe('reschedule moves the appointment atomically', () => {
  it('old slot freed, new slot booked, scheduled_at updated, emails + calendar enqueued per convention', async () => {
    const doc = await mkDoctor();
    const { p, id } = await confirmedAppt('09:00', doc);

    const res = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: `${MONDAY} 09:20` });
    expect(res.status).toBe(200);
    const newId = res.body.appointment.id;
    expect(newId).not.toBe(id);
    expect(res.body.appointment).toMatchObject({ status: 'confirmed', scheduledAt: `${MONDAY} 09:20:00` });
    expect(res.body.previous).toMatchObject({ id, status: 'rescheduled' });

    expect(await apptStatus(id)).toBe('rescheduled');
    expect(await apptStatus(newId)).toBe('confirmed');

    // Old time is bookable by a third party; new time is taken.
    const third = await mkPatient();
    expect((await hold(third, doc, '09:00')).status).toBe(201);
    const fourth = await mkPatient();
    const clash = await hold(fourth, doc, '09:20');
    expect(clash.status).toBe(409);
    expect(clash.body.error.code).toBe('SLOT_TAKEN');

    const notices = await query(
      `SELECT template FROM email_queue WHERE appointment_id = $1 AND template = 'reschedule_notice'`,
      [id],
    );
    expect(notices.rowCount).toBe(2);

    const oldCal = await query(
      `SELECT sync_status FROM calendar_events WHERE appointment_id = $1 ORDER BY audience`,
      [id],
    );
    expect(oldCal.rows.every((r) => r.sync_status === 'deleting')).toBe(true);

    const newCal = await query(
      `SELECT audience, sync_status FROM calendar_events WHERE appointment_id = $1 ORDER BY audience`,
      [newId],
    );
    expect(newCal.rows).toEqual([
      { audience: 'doctor', sync_status: 'pending' },
      { audience: 'patient', sync_status: 'pending' },
    ]);
  });
});

describe('reschedule target guards', () => {
  it('same slot as current appointment → allowed (no-op reschedule)', async () => {
    const { p, id } = await confirmedAppt('09:00');
    const res = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: `${MONDAY} 09:00` });
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('confirmed');
  });

  it('slot booked by another patient → 409 SLOT_TAKEN, original intact', async () => {
    const doc = await mkDoctor();
    const first = await confirmedAppt('09:00', doc);
    const mover = await confirmedAppt('09:20', doc);

    const res = await request(app)
      .patch(`/api/appointments/${mover.id}/reschedule`)
      .set('Cookie', mover.p.c)
      .send({ newScheduledAt: `${MONDAY} 09:00` });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
    expect(await apptStatus(mover.id)).toBe('confirmed');
    void first;

    // A bare hold on the target blocks rescheduling just the same.
    const holder = await mkPatient();
    await hold(holder, doc, '09:40');
    const res2 = await request(app)
      .patch(`/api/appointments/${mover.id}/reschedule`)
      .set('Cookie', mover.p.c)
      .send({ newScheduledAt: `${MONDAY} 09:40` });
    expect(res2.status).toBe(409);
    expect(res2.body.error.code).toBe('SLOT_TAKEN');
  });

  it('leave day → 409 DOCTOR_ON_LEAVE; off-grid / off-hours / non-working day / past → 422 SLOT_NOT_OPENABLE; original intact', async () => {
    const doc = await mkDoctor();
    const { p, id } = await confirmedAppt('09:00', doc);
    await query(`INSERT INTO leave_days (doctor_id, date) VALUES ($1, $2::date)`, [
      doc.userId, MONDAY,
    ]);

    // The leave day covers the whole date, so every MONDAY target reports the
    // date-level reason regardless of grid/hours.
    const mondayAttempts = [
      `${MONDAY} 09:20`, // on-grid slot
      `${MONDAY} 09:10`, // off-grid minute
      `${MONDAY} 12:00`, // outside 09:00–11:00 window
    ];
    for (const stamp of mondayAttempts) {
      const res = await request(app)
        .patch(`/api/appointments/${id}/reschedule`)
        .set('Cookie', p.c)
        .send({ newScheduledAt: stamp });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCTOR_ON_LEAVE');
    }

    const attempts = [
      `${TUESDAY} 09:00`, // not a working day
      `2026-08-03 09:00`, // in the past
    ];
    for (const stamp of attempts) {
      const res = await request(app)
        .patch(`/api/appointments/${id}/reschedule`)
        .set('Cookie', p.c)
        .send({ newScheduledAt: stamp });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SLOT_NOT_OPENABLE');
    }
    expect(await apptStatus(id)).toBe('confirmed');
  });
});

describe('hold boundaries', () => {
  it('holding an already-held slot (different patient) → 409 SLOT_TAKEN, original hold intact', async () => {
    const doc = await mkDoctor();
    const p1 = await mkPatient();
    const p2 = await mkPatient();
    const first = await hold(p1, doc, '09:00');
    expect(first.status).toBe(201);

    const second = await hold(p2, doc, '09:00');
    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SLOT_TAKEN');
    expect(await apptStatus(first.body.appointment.id)).toBe('held');
  });

  it('holding a booked (confirmed) slot → 409 SLOT_TAKEN', async () => {
    const doc = await mkDoctor();
    await confirmedAppt('09:00', doc);
    const other = await mkPatient();

    const res = await hold(other, doc, '09:00');
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');
  });

  it('second active hold by the same patient (same or different doctor) → 409 HOLD_EXISTS', async () => {
    const docA = await mkDoctor();
    const docB = await mkDoctor();
    const p = await mkPatient();

    const first = await hold(p, docA, '09:00');
    expect(first.status).toBe(201);

    const sameDoc = await hold(p, docA, '09:20');
    expect(sameDoc.status).toBe(409);
    expect(sameDoc.body.error.code).toBe('HOLD_EXISTS');

    const otherDoc = await hold(p, docB, '09:00');
    expect(otherDoc.status).toBe(409);
    expect(otherDoc.body.error.code).toBe('HOLD_EXISTS');
  });

  it('past / non-working-day → 422 SLOT_NOT_OPENABLE; any target on a leave day → 409 DOCTOR_ON_LEAVE', async () => {
    const doc = await mkDoctor();
    const p = await mkPatient();
    await query(`INSERT INTO leave_days (doctor_id, date) VALUES ($1, $2::date)`, [
      doc.userId, MONDAY,
    ]);

    const attempts = [
      `2026-08-03 09:00`, // past
      `${TUESDAY} 09:00`, // non-working day
    ];
    for (const stamp of attempts) {
      const res = await request(app)
        .post(`/api/doctors/${doc.userId}/slots/hold`)
        .set('Cookie', p.c)
        .send({ scheduledAt: stamp });
      expect(res.status).toBe(422);
      expect(res.body.error.code).toBe('SLOT_NOT_OPENABLE');
    }

    // The leave day covers the whole date , date-level reason wins over
    // time-level ones (grid/hours).
    const mondayAttempts = [
      `${MONDAY} 09:20`, // on-grid slot
      `${MONDAY} 12:00`, // outside hours
      `${MONDAY} 09:10`, // off-grid
    ];
    for (const stamp of mondayAttempts) {
      const res = await request(app)
        .post(`/api/doctors/${doc.userId}/slots/hold`)
        .set('Cookie', p.c)
        .send({ scheduledAt: stamp });
      expect(res.status).toBe(409);
      expect(res.body.error.code).toBe('DOCTOR_ON_LEAVE');
    }

    expect(
      (await query(`SELECT count(*)::int n FROM appointments WHERE patient_id = $1`, [p.id])).rows[0].n,
    ).toBe(0);
  });

  it('hold expiry via injected clock frees the slot for a different patient', async () => {
    const doc = await mkDoctor();
    const p1 = await mkPatient();
    const stale = await hold(p1, doc, '10:40');
    expect(stale.status).toBe(201);

    tickMinutes(6);
    await expireHolds({ pool, now: () => NOW });
    expect(await apptStatus(stale.body.appointment.id)).toBe('expired');

    const p2 = await mkPatient();
    expect((await hold(p2, doc, '10:40')).status).toBe(201);
    tickMinutes(0);
  });
});

describe('symptom-submit validation does not consume the hold', () => {
  async function heldFixture() {
    const doc = await mkDoctor();
    const p = await mkPatient();
    const h = await hold(p, doc, '10:20');
    expect(h.status).toBe(201);
    return { doc, p, id: h.body.appointment.id };
  }

  const cases = [
    ['empty body {}', {}, 422, 'SYMPTOMS_REQUIRED'],
    ['empty description', { ...SYMPTOMS, symptomsText: '' }, 422, 'SYMPTOMS_REQUIRED'],
    ['whitespace description', { ...SYMPTOMS, symptomsText: '   ' }, 422, 'SYMPTOMS_REQUIRED'],
    ['empty duration', { ...SYMPTOMS, durationText: '' }, 422, 'SYMPTOMS_REQUIRED'],
    ['severity outside enum', { ...SYMPTOMS, severity: 'apocalyptic' }, 400, 'VALIDATION_ERROR'],
    ['absurd duration length', { ...SYMPTOMS, durationText: 'x'.repeat(121) }, 400, 'VALIDATION_ERROR'],
    ['absurd description length', { ...SYMPTOMS, symptomsText: 'x'.repeat(2001) }, 400, 'VALIDATION_ERROR'],
  ];

  for (const [name, payload, expectedStatus, expectedCode] of cases) {
    it(`${name} → ${expectedStatus} ${expectedCode}, hold survives and confirms afterwards`, async () => {
      const { p, id } = await heldFixture();

      const bad = await confirmHeld(p, id, payload);
      expect(bad.status).toBe(expectedStatus);
      expect(bad.body.error?.code ?? '').toBe(expectedCode);
      expect(await apptStatus(id)).toBe('held');

      const ok = await confirmHeld(p, id);
      expect(ok.status).toBe(200);
      expect(ok.body.appointment.status).toBe('confirmed');
    });
  }
});
