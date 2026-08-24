import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { getTestPool, testConfig, resetDb, closeTestPool } from './helpers.js';

const pool = await getTestPool();
const config = testConfig({ HOLD_MINUTES: '5' });
const NOW = new Date('2026-08-20T08:00:00');
const app = createApp({
  config,
  pool,
  now: () => NOW,
});

function cookie(id, role) {
  return `hcm_session=${jwt.sign({ sub: String(id), role }, config.jwtSecret)}`;
}

let adminC;
const MONDAY = '2026-08-24';
const SLOT_A = `${MONDAY} 09:20`;

async function mkDoctor(email, spec = 'General Medicine') {
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminC)
    .send({
      email, name: `Dr. ${email.split('@')[0]}`, password: 'doctor-pass-1',
      specialisation: spec, workingDays: [1], startsAt: '09:00', endsAt: '11:00', slotMinutes: 20,
    });
  return res.body.doctor;
}

async function mkPatient(n) {
  const res = await request(app).post('/api/auth/register').send({
    email: `patient${n}@ashgrove.health`, name: `Patient ${n}`, password: 'long-enough-1',
  });
  const id = res.body.user.id;
  return { id, c: cookie(id, 'patient') };
}

beforeAll(async () => {
  await resetDb();
  adminC = `hcm_session=${jwt.sign({ sub: '999', role: 'admin' }, config.jwtSecret)}`;
});

afterAll(closeTestPool);

describe('POST /api/doctors/:id/slots/hold', () => {
  it('holds an open slot for its holder with a 5-minute expiry', async () => {
    const doc = await mkDoctor('hold.doc@ashgrove.health');
    const p1 = await mkPatient(1);

    const res = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p1.c)
      .send({ scheduledAt: SLOT_A });

    expect(res.status).toBe(201);
    expect(res.body.appointment).toMatchObject({
      status: 'held', doctorId: Number(doc.userId), scheduledAt: `${SLOT_A}:00`,
    });

    const { rows } = await pool.query(
      `SELECT hold_expires_at FROM appointments WHERE id = $1`,
      [res.body.appointment.id],
    );
    expect(new Date(rows[0].hold_expires_at).getTime()).toBe(NOW.getTime() + 5 * 60_000);
  });

  it('second patient on the same slot → 409 SLOT_TAKEN (sequential)', async () => {
    const doc = await mkDoctor('seq.doc@ashgrove.health');
    const p1 = await mkPatient(2);
    const p2 = await mkPatient(3);

    await request(app).post(`/api/doctors/${doc.userId}/slots/hold`).set('Cookie', p1.c)
      .send({ scheduledAt: SLOT_A });
    const second = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p2.c)
      .send({ scheduledAt: SLOT_A });

    expect(second.status).toBe(409);
    expect(second.body.error.code).toBe('SLOT_TAKEN');
  });

  it('CONCURRENCY: 8 parallel holds → exactly one 201, seven SLOT_TAKEN, one live row', async () => {
    const doc = await mkDoctor('race.doc@ashgrove.health');
    const patients = [];
    for (let i = 0; i < 8; i += 1) patients.push(await mkPatient(10 + i));

    const attempts = patients.map((p) =>
      request(app)
        .post(`/api/doctors/${doc.userId}/slots/hold`)
        .set('Cookie', p.c)
        .send({ scheduledAt: SLOT_A }),
    );
    const results = await Promise.all(attempts);

    const created = results.filter((r) => r.status === 201);
    const taken = results.filter((r) => r.status === 409 && r.body.error.code === 'SLOT_TAKEN');
    expect(created).toHaveLength(1);
    expect(taken).toHaveLength(7);

    const { rows } = await pool.query(
      `SELECT status FROM appointments WHERE doctor_id = $1 AND scheduled_at = $2::timestamp`,
      [doc.userId, SLOT_A],
    );
    expect(rows.map((r) => r.status).sort()).toEqual(['held']);
  });

  it('same patient may re-hold only after expiry (supersede); unexpired → 409 HOLD_EXISTS', async () => {
    const doc = await mkDoctor('rehold.doc@ashgrove.health');
    const p = await mkPatient(30);
    const otherSlot = `${MONDAY} 09:40`;

    const first = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p.c)
      .send({ scheduledAt: otherSlot });
    expect(first.status).toBe(201);

    const again = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p.c)
      .send({ scheduledAt: `${MONDAY} 10:00` });
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('HOLD_EXISTS');

    // Backdate the first hold past its expiry, then re-hold succeeds and supersedes.
    await pool.query(
      `UPDATE appointments SET hold_expires_at = $2::timestamptz WHERE id = $1`,
      [first.body.appointment.id, new Date(NOW.getTime() - 1000)],
    );
    const superseded = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p.c)
      .send({ scheduledAt: `${MONDAY} 10:00` });
    expect(superseded.status).toBe(201);

    const { rows } = await pool.query(
      `SELECT status FROM appointments WHERE patient_id = $1 ORDER BY status`,
      [p.id],
    );
    expect(rows.map((r) => r.status)).toEqual(['expired', 'held']);
  });

  it('rejects non-openable targets: off-grid time, off-hours, leave day, past', async () => {
    const doc = await mkDoctor('guard.doc@ashgrove.health');
    const p = await mkPatient(40);
    await pool.query(`INSERT INTO leave_days (doctor_id, date) VALUES ($1, $2::date)`, [
      doc.userId, MONDAY,
    ]);

    async function tryHold(stamp) {
      return request(app)
        .post(`/api/doctors/${doc.userId}/slots/hold`)
        .set('Cookie', p.c)
        .send({ scheduledAt: stamp });
    }

    // Any target on a leave-covered date reports the date-level reason.
    const mondayAttempts = [
      tryHold(`${MONDAY} 09:10`), // off-grid minute
      tryHold(`${MONDAY} 12:00`), // outside hours
      tryHold(SLOT_A), // on-grid slot
    ];
    for (const r of await Promise.all(mondayAttempts)) {
      expect(r.status).toBe(409);
      expect(r.body.error.code).toBe('DOCTOR_ON_LEAVE');
    }
    const offHours = await tryHold('2026-08-25 12:00'); // Tuesday, outside hours
    const wrongDay = await tryHold('2026-08-25 09:20'); // TUESDAY, not working
    const past = await tryHold('2026-08-03 09:20');
    for (const r of [offHours, wrongDay, past]) {
      expect(r.status).toBe(422);
      expect(r.body.error.code).toBe('SLOT_NOT_OPENABLE');
    }
  });

  it('requires a patient session', async () => {
    const doc = await mkDoctor('noauth.doc@ashgrove.health');
    const res = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .send({ scheduledAt: SLOT_A });
    expect(res.status).toBe(401);
  });
});

describe('POST /api/appointments/:id/confirm', () => {
  async function setupHeld() {
    const doc = await mkDoctor(`conf${Math.random().toString(36).slice(2, 7)}@ashgrove.health`);
    const p = await mkPatient(Math.floor(Math.random() * 100000));
    const hold = await request(app)
      .post(`/api/doctors/${doc.userId}/slots/hold`)
      .set('Cookie', p.c)
      .send({ scheduledAt: `${MONDAY} 10:20` });
    return { doc, p, appointmentId: hold.body.appointment.id };
  }

  const SYMPTOMS = {
    symptomsText: 'Persistent dry cough for five days, worse at night, mild fever.',
    severity: 'moderate',
    durationText: '5 days',
  };

  it('flips held→confirmed, stores symptoms, queues emails + calendar + pending summary + audit', async () => {
    const { p, appointmentId } = await setupHeld();

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', p.c)
      .send(SYMPTOMS);
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('confirmed');

    const appt = await pool.query(
      `SELECT symptoms_text, severity, duration_text FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    expect(appt.rows[0]).toMatchObject({
      symptoms_text: SYMPTOMS.symptomsText, severity: 'moderate', duration_text: '5 days',
    });

    const emails = await pool.query(
      `SELECT to_email, template FROM email_queue WHERE appointment_id = $1 ORDER BY template`,
      [appointmentId],
    );
    expect(emails.rowCount).toBe(2);
    expect(emails.rows.map((r) => r.template)).toEqual(['booking_confirmation', 'booking_confirmation']);

    const cal = await pool.query(
      `SELECT audience, sync_status FROM calendar_events WHERE appointment_id = $1 ORDER BY audience`,
      [appointmentId],
    );
    expect(cal.rows).toEqual([
      { audience: 'doctor', sync_status: 'pending' },
      { audience: 'patient', sync_status: 'pending' },
    ]);

    const summary = await pool.query(
      `SELECT generation_status FROM pre_visit_summaries WHERE appointment_id = $1`,
      [appointmentId],
    );
    expect(summary.rows[0].generation_status).toBe('pending');

    const events = await pool.query(
      `SELECT from_status, to_status, actor_role FROM appointment_events WHERE appointment_id = $1
       AND to_status = 'confirmed'`,
      [appointmentId],
    );
    expect(events.rows[0]).toMatchObject({ from_status: 'held', to_status: 'confirmed', actor_role: 'patient' });
  });

  it('missing symptoms → 422 SYMPTOMS_REQUIRED; bad severity → 400 VALIDATION_ERROR', async () => {
    const { p, appointmentId } = await setupHeld();
    const noSymptoms = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', p.c)
      .send({});
    expect(noSymptoms.status).toBe(422);
    expect(noSymptoms.body.error.code).toBe('SYMPTOMS_REQUIRED');

    // Hold is untouched; now send invalid severity.
    const badSeverity = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', p.c)
      .send({ ...SYMPTOMS, severity: 'apocalyptic' });
    expect(badSeverity.status).toBe(400);
    expect(badSeverity.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('expired hold → 410 HOLD_EXPIRED (row left expired-capable)', async () => {
    const { p, appointmentId } = await setupHeld();
    await pool.query(
      `UPDATE appointments SET hold_expires_at = $2::timestamptz WHERE id = $1`,
      [appointmentId, new Date(NOW.getTime() - 60_000)],
    );

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', p.c)
      .send(SYMPTOMS);
    expect(res.status).toBe(410);
    expect(res.body.error.code).toBe('HOLD_EXPIRED');

    const still = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [appointmentId]);
    expect(still.rows[0].status).toBe('held'); // sweeper expires it later
  });

  it("another patient's hold is invisible → 404", async () => {
    const { p1, appointmentId } = await (async () => {
      const s = await setupHeld();
      return { p1: s.p, appointmentId: s.appointmentId };
    })();
    const stranger = await mkPatient(7777);

    const res = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', stranger.c)
      .send(SYMPTOMS);
    expect(res.status).toBe(404);

    // Original holder can still confirm.
    const ok = await request(app)
      .post(`/api/appointments/${appointmentId}/confirm`)
      .set('Cookie', p1.c)
      .send(SYMPTOMS);
    expect(ok.status).toBe(200);
  });

  it('double-confirm replay races → exactly one success, one confirmed row', async () => {
    const { p, appointmentId } = await setupHeld();
    const [a, b] = await Promise.all([
      request(app).post(`/api/appointments/${appointmentId}/confirm`).set('Cookie', p.c).send(SYMPTOMS),
      request(app).post(`/api/appointments/${appointmentId}/confirm`).set('Cookie', p.c).send(SYMPTOMS),
    ]);
    const statuses = [a.status, b.status].sort((x, y) => x - y);
    expect(statuses[0]).toBe(200);
    expect(statuses[1]).toBeGreaterThanOrEqual(400);

    const rows = await pool.query(
      `SELECT status FROM appointments WHERE id = $1`,
      [appointmentId],
    );
    expect(rows.rows[0].status).toBe('confirmed');
  });
});
