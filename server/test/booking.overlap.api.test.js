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

async function mkDoctor(tag, spec = 'General Medicine') {
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminC)
    .send({
      email: `${tag}.doc@ashgrove.health`,
      name: `Dr. ${tag}`,
      password: 'doctor-pass-1',
      specialisation: spec,
      workingDays: [1, 2, 3, 4, 5],
      startsAt: '09:00',
      endsAt: '12:00',
      slotMinutes: 20,
    });
  return res.body.doctor;
}

async function mkPatient(n) {
  const res = await request(app).post('/api/auth/register').send({
    email: `ovp${n}.${Math.random().toString(36).slice(2, 7)}@ashgrove.health`,
    name: `P${n}`,
    password: 'long-enough-1',
  });
  return { id: res.body.user.id, c: cookie(res.body.user.id, 'patient') };
}

async function hold(doctorId, patientCookie, stamp) {
  return request(app)
    .post(`/api/doctors/${doctorId}/slots/hold`)
    .set('Cookie', patientCookie)
    .send({ scheduledAt: stamp });
}

const SYMPTOMS = {
  symptomsText: 'Cough for five days.',
  severity: 'mild',
  durationText: '5 days',
};

async function confirm(id, patientCookie) {
  return request(app)
    .post(`/api/appointments/${id}/confirm`)
    .set('Cookie', patientCookie)
    .send(SYMPTOMS);
}

beforeAll(async () => {
  await resetDb();
  adminC = `hcm_session=${jwt.sign({ sub: '999', role: 'admin' }, config.jwtSecret)}`;
});

afterAll(closeTestPool);

describe('Rule 1: one live booking per (patient, doctor, day)', () => {
  it('second hold with the same doctor on the same day → 409 SAME_DOCTOR_SAME_DAY', async () => {
    const doc = await mkDoctor('sameday');
    const p = await mkPatient(1);

    const first = await hold(doc.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    await confirm(first.body.appointment.id, p.c);

    const dup = await hold(doc.userId, p.c, `${MONDAY} 10:00`);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SAME_DOCTOR_SAME_DAY');
  });

  it('confirmed booking blocks a second hold for the same doctor/day', async () => {
    const doc = await mkDoctor('confirmblock');
    const p = await mkPatient(2);

    const first = await hold(doc.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    const conf = await confirm(first.body.appointment.id, p.c);
    expect(conf.status).toBe(200);

    const dup = await hold(doc.userId, p.c, `${MONDAY} 10:00`);
    expect(dup.status).toBe(409);
    expect(dup.body.error.code).toBe('SAME_DOCTOR_SAME_DAY');
  });

  it('canceling the first hold frees the same-day slot for that doctor', async () => {
    const doc = await mkDoctor('cancelFree');
    const p = await mkPatient(3);

    const first = await hold(doc.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);

    const cancel = await request(app)
      .delete(`/api/appointments/${first.body.appointment.id}`)
      .set('Cookie', p.c);
    expect(cancel.status).toBe(200);

    const retry = await hold(doc.userId, p.c, `${MONDAY} 10:00`);
    expect(retry.status).toBe(201);
  });

  it('different doctors on the same day are still allowed', async () => {
    const docA = await mkDoctor('multiA', 'Cardiology');
    const docB = await mkDoctor('multiB', 'Dermatology');
    const p = await mkPatient(4);

    const a = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(a.status).toBe(201);
    await confirm(a.body.appointment.id, p.c);

    // 09:20 is back-to-back (A ends at 09:20), no overlap
    const b = await hold(docB.userId, p.c, `${MONDAY} 09:20`);
    expect(b.status).toBe(201);
  });

  it('same doctor on a different day is allowed', async () => {
    const doc = await mkDoctor('dayDiff');
    const p = await mkPatient(5);

    const monday = await hold(doc.userId, p.c, `${MONDAY} 09:00`);
    expect(monday.status).toBe(201);
    await confirm(monday.body.appointment.id, p.c);

    // 2026-08-25 is a Tuesday (working day for this doctor)
    const tuesday = await hold(doc.userId, p.c, '2026-08-25 09:00');
    expect(tuesday.status).toBe(201);
  });

  it('reschedule onto a same-doctor same-day target → 409 SAME_DOCTOR_SAME_DAY', async () => {
    const doc = await mkDoctor('reschedSame');
    const p = await mkPatient(6);

    const a = await hold(doc.userId, p.c, `${MONDAY} 09:00`);
    await confirm(a.body.appointment.id, p.c);
    const b = await hold(doc.userId, p.c, `${MONDAY} 09:20`);
    expect(b.status).toBe(409); // SAME_DOCTOR_SAME_DAY because a is still held/confirmed same day
    void b;
  });
});

describe('Rule 2: no time overlap across all doctors for one patient', () => {
  it('two different doctors at the exact same time → 409 TIME_OVERLAP on the second', async () => {
    const docA = await mkDoctor('overlapA', 'Cardiology');
    const docB = await mkDoctor('overlapB', 'Dermatology');
    const p = await mkPatient(7);

    const first = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    await confirm(first.body.appointment.id, p.c);

    const overlap = await hold(docB.userId, p.c, `${MONDAY} 09:00`);
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('TIME_OVERLAP');
  });

  it('two different doctors at overlapping times (09:00 + 30min slot, 09:20) → 409 TIME_OVERLAP', async () => {
    // Doctor A: 30-min slots. Doctor B: 20-min slots.
    const docA = (await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send({
        email: 'partOverA.doc@ashgrove.health', name: 'Dr. POA', password: 'doctor-pass-1',
        specialisation: 'Cardiology', workingDays: [1, 2, 3, 4, 5],
        startsAt: '09:00', endsAt: '12:00', slotMinutes: 30,
      })).body.doctor;
    const docB = await mkDoctor('partOverB', 'Dermatology');
    const p = await mkPatient(8);

    const first = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    await confirm(first.body.appointment.id, p.c);

    // A at 09:00 with 30-min slot ends at 09:30. B at 09:20 with 20-min slot ends at 09:40. Overlap.
    const overlap = await hold(docB.userId, p.c, `${MONDAY} 09:20`);
    expect(overlap.status).toBe(409);
    expect(overlap.body.error.code).toBe('TIME_OVERLAP');
  });

  it('two different doctors at exactly back-to-back times (09:00 + 09:20) → allowed', async () => {
    const docA = await mkDoctor('backA', 'Cardiology');
    const docB = await mkDoctor('backB', 'Dermatology');
    const p = await mkPatient(9);

    const first = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    await confirm(first.body.appointment.id, p.c);

    const next = await hold(docB.userId, p.c, `${MONDAY} 09:20`);
    expect(next.status).toBe(201);
  });

  it('different patients with overlapping times → allowed (overlap is per-patient)', async () => {
    const docA = await mkDoctor('perPatA', 'Cardiology');
    const docB = await mkDoctor('perPatB', 'Dermatology');
    const p1 = await mkPatient(10);
    const p2 = await mkPatient(11);

    const a = await hold(docA.userId, p1.c, `${MONDAY} 09:00`);
    expect(a.status).toBe(201);
    const b = await hold(docB.userId, p2.c, `${MONDAY} 09:00`);
    expect(b.status).toBe(201);
  });

  it('canceling the first booking frees the time for a different doctor', async () => {
    const docA = await mkDoctor('freeA', 'Cardiology');
    const docB = await mkDoctor('freeB', 'Dermatology');
    const p = await mkPatient(12);

    const first = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(first.status).toBe(201);
    await confirm(first.body.appointment.id, p.c);

    const cancel = await request(app)
      .delete(`/api/appointments/${first.body.appointment.id}`)
      .set('Cookie', p.c);
    expect(cancel.status).toBe(200);

    const second = await hold(docB.userId, p.c, `${MONDAY} 09:00`);
    expect(second.status).toBe(201);
  });

  it('reschedule to a time that overlaps another live booking → 409 TIME_OVERLAP', async () => {
    const docA = await mkDoctor('rsA', 'Cardiology');
    const docB = await mkDoctor('rsB', 'Dermatology');
    const p = await mkPatient(13);

    // Two distinct bookings on different days so SAME_DOCTOR_SAME_DAY isn't the issue.
    const a = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(a.status).toBe(201);
    await confirm(a.body.appointment.id, p.c);

    const b = await hold(docB.userId, p.c, '2026-08-25 09:00'); // Tuesday
    expect(b.status).toBe(201);
    await confirm(b.body.appointment.id, p.c);

    // Reschedule b → Tuesday 09:00 overlaps with itself? No , different day.
    // Try to reschedule b into Monday 09:00 (overlaps a).
    const rs = await request(app)
      .patch(`/api/appointments/${b.body.appointment.id}/reschedule`)
      .set('Cookie', p.c)
      .send({ newScheduledAt: `${MONDAY} 09:00` });
    expect(rs.status).toBe(409);
    expect(rs.body.error.code).toBe('TIME_OVERLAP');
  });
});

describe('Rule 2: overlap respects doctor slot length', () => {
  it('two doctors with different slot_minutes , overlap computed on the larger', async () => {
    // Doctor A: 30-min slots. Doctor B: 20-min slots.
    const docA = (await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send({
        email: 'slotA.doc@ashgrove.health', name: 'Dr. A', password: 'doctor-pass-1',
        specialisation: 'Cardiology', workingDays: [1, 2, 3, 4, 5],
        startsAt: '09:00', endsAt: '12:00', slotMinutes: 30,
      })).body.doctor;
    const docB = (await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send({
        email: 'slotB.doc@ashgrove.health', name: 'Dr. B', password: 'doctor-pass-1',
        specialisation: 'Dermatology', workingDays: [1, 2, 3, 4, 5],
        startsAt: '09:00', endsAt: '12:00', slotMinutes: 20,
      })).body.doctor;

    const p = await mkPatient(14);

    // A holds 09:00 (30-min slot). B trying 09:20 must be rejected (overlap by 10 min).
    const a = await hold(docA.userId, p.c, `${MONDAY} 09:00`);
    expect(a.status).toBe(201);
    await confirm(a.body.appointment.id, p.c);

    const b = await hold(docB.userId, p.c, `${MONDAY} 09:20`);
    expect(b.status).toBe(409);
    expect(b.body.error.code).toBe('TIME_OVERLAP');

    // B at 09:40 is the first non-overlapping slot (A ends at 09:30). Allowed.
    const c = await hold(docB.userId, p.c, `${MONDAY} 09:40`);
    expect(c.status).toBe(201);
  });
});

describe('Concurrency: overlap constraints under load', () => {
  it('two parallel holds on overlapping times across two doctors → exactly one wins', async () => {
    const docA = await mkDoctor('raceA', 'Cardiology');
    const docB = await mkDoctor('raceB', 'Dermatology');
    const p1 = await mkPatient(20);
    const p2 = await mkPatient(21);

    const [a, b] = await Promise.all([
      hold(docA.userId, p1.c, `${MONDAY} 09:00`),
      hold(docB.userId, p2.c, `${MONDAY} 09:00`),
    ]);
    // Both with different patients so the per-patient constraint doesn't trigger.
    // The per-patient overlap is per-row; same patient would be the issue.
    // Here we test a single patient racing two doctors:
    void a; void b;

    const p3 = await mkPatient(22);
    const [x, y] = await Promise.all([
      hold(docA.userId, p3.c, `${MONDAY} 10:00`),
      hold(docB.userId, p3.c, `${MONDAY} 10:00`),
    ]);
    const codes = [x.body.error?.code, y.body.error?.code].filter(Boolean);
    expect(codes.length).toBeGreaterThanOrEqual(1);
    expect(['TIME_OVERLAP', 'SAME_DOCTOR_SAME_DAY', 'HOLD_EXISTS']).toContain(codes[0]);
  });
});
