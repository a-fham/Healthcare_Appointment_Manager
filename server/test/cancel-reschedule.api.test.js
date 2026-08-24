import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { getTestPool, testConfig, resetDb, closeTestPool } from './helpers.js';

const pool = await getTestPool();
const config = testConfig();
const NOW = new Date('2026-08-20T08:00:00');
const app = createApp({ config, pool, now: () => NOW });

const cookie = (id, role) =>
  `hcm_session=${jwt.sign({ sub: String(id), role }, config.jwtSecret)}`;

let adminC;
const MONDAY = '2026-08-24';

async function mkDoctor(tag) {
  const res = await request(app).post('/api/admin/doctors').set('Cookie', adminC).send({
    email: `cxl.${tag}@ashgrove.health`, name: `Dr. ${tag}`, password: 'doctor-pass-1',
    specialisation: 'General Medicine', workingDays: [1],
    startsAt: '09:00', endsAt: '11:00', slotMinutes: 20,
  });
  return res.body.doctor;
}

async function mkPatient(n) {
  const res = await request(app).post('/api/auth/register').send({
    email: `cxlp${n}.${tag()}@ashgrove.health`, name: `P${n}`, password: 'long-enough-1',
  });
  return { id: res.body.user.id, c: cookie(res.body.user.id, 'patient') };
}
let seq = 100;
const tag = () => (seq += 1);

const SYMPTOMS = {
  symptomsText: 'Lower back pain radiating down the left leg.',
  severity: 'moderate',
  durationText: '2 weeks',
};

async function confirmedAppt(slotTime, existingDoctor = null) {
  const doc = existingDoctor ?? (await mkDoctor(tag()));
  const p = await mkPatient(tag());
  const hold = await request(app)
    .post(`/api/doctors/${doc.userId}/slots/hold`)
    .set('Cookie', p.c)
    .send({ scheduledAt: `${MONDAY} ${slotTime}` });
  const conf = await request(app)
    .post(`/api/appointments/${hold.body.appointment.id}/confirm`)
    .set('Cookie', p.c)
    .send(SYMPTOMS);
  return { doc, p, id: conf.body.appointment.id };
}

beforeAll(async () => {
  await resetDb();
  adminC = `hcm_session=${jwt.sign({ sub: '999', role: 'admin' }, config.jwtSecret)}`;
});

afterAll(closeTestPool);

describe('DELETE /api/appointments/:id (cancel)', () => {
  it('patient cancels own confirmed booking: emails + calendar deletion queued, slot freed', async () => {
    const { p, id } = await confirmedAppt('09:00');

    const res = await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('cancelled_by_patient');

    const emails = await pool.query(
      `SELECT template FROM email_queue WHERE appointment_id = $1 AND template = 'cancellation'`,
      [id],
    );
    expect(emails.rowCount).toBe(2);

    const cal = await pool.query(
      `SELECT sync_status FROM calendar_events WHERE appointment_id = $1`,
      [id],
    );
    expect(cal.rows.every((r) => r.sync_status === 'deleting')).toBe(true);

    const evt = await pool.query(
      `SELECT to_status, actor_role FROM appointment_events WHERE appointment_id = $1 ORDER BY id DESC LIMIT 1`,
      [id],
    );
    expect(evt.rows[0]).toMatchObject({ to_status: 'cancelled_by_patient', actor_role: 'patient' });

    // Slot capacity is free again: another patient can hold it.
    const other = await mkPatient(tag());
    const reHold = await request(app)
      .post(`/api/doctors/${(await mkDoctor(tag())).userId}/slots/hold`)
      .set('Cookie', other.c)
      .send({ scheduledAt: `${MONDAY} 09:00` });
    expect(reHold.status).toBe(201);
  });

  it("another patient's booking is invisible (404)", async () => {
    const { id } = await confirmedAppt('09:20');
    const stranger = await mkPatient(tag());
    const res = await request(app).delete(`/api/appointments/${id}`).set('Cookie', stranger.c);
    expect(res.status).toBe(404);
  });

  it('admin may cancel on behalf; status reflects actor', async () => {
    const { id } = await confirmedAppt('09:40');
    const res = await request(app).delete(`/api/appointments/${id}`).set('Cookie', adminC);
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('cancelled_by_admin');
  });

  it('double-cancel → 409 CONFLICT', async () => {
    const { p, id } = await confirmedAppt('10:00');
    await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    const again = await request(app).delete(`/api/appointments/${id}`).set('Cookie', p.c);
    expect(again.status).toBe(409);
    expect(again.body.error.code).toBe('CONFLICT');
  });
});

describe('PATCH /api/appointments/:id/reschedule', () => {
  it('moves a confirmed booking atomically; old slot freed, notifications queued, audit trail kept', async () => {
    const { p, id } = await confirmedAppt('10:20');

    const res = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: `${MONDAY} 10:40` });
    expect(res.status).toBe(200);
    expect(res.body.appointment.status).toBe('confirmed');
    expect(res.body.appointment.scheduledAt).toBe(`${MONDAY} 10:40:00`);

    const original = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(original.rows[0].status).toBe('rescheduled');

    const notices = await pool.query(
      `SELECT template FROM email_queue WHERE appointment_id = $1 AND template = 'reschedule_notice'`,
      [id],
    );
    expect(notices.rowCount).toBe(2);

    const oldCal = await pool.query(
      `SELECT sync_status FROM calendar_events WHERE appointment_id = $1`,
      [id],
    );
    expect(oldCal.rows.every((r) => r.sync_status === 'deleting')).toBe(true);
  });

  it('target conflict → 409 SLOT_TAKEN and original untouched (transactionality)', async () => {
    const first = await confirmedAppt('09:00'); // takes 09:00 with this doctor
    const mover = await confirmedAppt('09:20', first.doc); // same doctor, wants 09:00

    const res = await request(app)
      .patch(`/api/appointments/${mover.id}/reschedule`)
      .set('Cookie', mover.p.c)
      .send({ newScheduledAt: `${MONDAY} 09:00` });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('SLOT_TAKEN');

    const orig = await pool.query(
      `SELECT status, to_char(scheduled_at,'YYYY-MM-DD HH24:MI') t FROM appointments WHERE id = $1`,
      [mover.id],
    );
    expect(orig.rows[0]).toMatchObject({ status: 'confirmed', t: `${MONDAY} 09:20` });

    const strays = await pool.query(
      `SELECT count(*)::int n FROM appointments WHERE doctor_id = (SELECT doctor_id FROM appointments WHERE id=$1) AND status='held'`,
      [mover.id],
    );
    expect(strays.rows[0].n).toBe(0);
  });

  it('rescheduling to a non-openable time → 422, original intact', async () => {
    const { p, id } = await confirmedAppt('09:00');
    const res = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: '2026-08-25 09:00' }); // Tuesday , not a working day
    expect(res.status).toBe(422);
    expect(res.body.error.code).toBe('SLOT_NOT_OPENABLE');

    const orig = await pool.query(`SELECT status FROM appointments WHERE id = $1`, [id]);
    expect(orig.rows[0].status).toBe('confirmed');
  });

  it("another patient's booking cannot be rescheduled (404)", async () => {
    const { id } = await confirmedAppt('09:00');
    const stranger = await mkPatient(tag());
    const res = await request(app)
      .patch(`/api/appointments/${id}/reschedule`)
      .set('Cookie', stranger.c)
      .send({ newScheduledAt: `${MONDAY} 10:40` });
    expect(res.status).toBe(404);
  });
});
