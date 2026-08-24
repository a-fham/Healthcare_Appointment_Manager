import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../src/app.js';
import { getTestPool, testConfig, resetDb, closeTestPool } from './helpers.js';

const pool = await getTestPool();
const config = testConfig();
const FIXED_NOW = '2000-01-01 00:00';
const app = createApp({ config, pool, nowStr: () => FIXED_NOW });

const adminToken = () =>
  `hcm_session=${jwt.sign({ sub: '1', role: 'admin' }, config.jwtSecret)}`;

let doctorId;

beforeAll(async () => {
  await resetDb();
  const res = await request(app)
    .post('/api/admin/doctors')
    .set('Cookie', adminToken())
    .send({
      email: 'slots.doc@ashgrove.health',
      name: 'Dr. Slots',
      password: 'doctor-pass-1',
      specialisation: 'Cardiology',
      workingDays: [1], // Mondays only
      startsAt: '09:00',
      endsAt: '11:00',
      slotMinutes: 30,
    });
  doctorId = res.body.doctor.userId;
});

afterAll(closeTestPool);

const MONDAY = '2026-08-24';

describe('GET /api/doctors', () => {
  it('lists all doctors with schedules', async () => {
    const res = await request(app).get('/api/doctors');
    expect(res.status).toBe(200);
    expect(res.body.doctors).toHaveLength(1);
    expect(res.body.doctors[0].specialisation).toBe('Cardiology');
  });

  it('filters case-insensitively by specialisation substring', async () => {
    const hit = await request(app).get('/api/doctors').query({ specialisation: 'cardio' });
    expect(hit.body.doctors).toHaveLength(1);
    const miss = await request(app).get('/api/doctors').query({ specialisation: 'neuro' });
    expect(miss.body.doctors).toHaveLength(0);
  });

  it('?sort=garbage falls back to default ordering without error', async () => {
    const res = await request(app).get('/api/doctors').query({ sort: "name; DROP TABLE users" });
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body.doctors)).toBe(true);
  });
});

describe('GET /api/doctors/:id/slots', () => {
  it('returns open slots on a working day', async () => {
    const res = await request(app).get(`/api/doctors/${doctorId}/slots`).query({ date: MONDAY });
    expect(res.status).toBe(200);
    expect(res.body.slots.map((s) => s.startsAt)).toEqual(['09:00', '09:30', '10:00', '10:30']);
    expect(res.body.slots.every((s) => s.status === 'open')).toBe(true);
  });

  it('returns [] on non-working days and leave days', async () => {
    const offDay = await request(app)
      .get(`/api/doctors/${doctorId}/slots`)
      .query({ date: '2026-08-25' }); // Tuesday, not working
    expect(offDay.body.slots).toEqual([]);

    await pool.query(
      `INSERT INTO leave_days (doctor_id, date) VALUES ($1, $2::date)`,
      [doctorId, '2026-08-31'],
    );
    const leave = await request(app)
      .get(`/api/doctors/${doctorId}/slots`)
      .query({ date: '2026-08-31' }); // Monday but on leave
    expect(leave.body.slots).toEqual([]);
  });

  it('marks booked/held times taken', async () => {
    await resetDb();
    // recreate doctor after truncate
    const created = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminToken())
      .send({
        email: 'slots2.doc@ashgrove.health',
        name: 'Dr. Slots II',
        password: 'doctor-pass-1',
        specialisation: 'Cardiology',
        workingDays: [1],
        startsAt: '09:00',
        endsAt: '11:00',
        slotMinutes: 30,
      });
    const id = created.body.doctor.userId;

    const patient = await request(app).post('/api/auth/register').send({
      email: 'booker@ashgrove.health', name: 'Booker', password: 'long-enough-1',
    });
    await pool.query(
      `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status)
       VALUES ($1, $2, $3::timestamp, 'confirmed')`,
      [patient.body.user.id, id, `${MONDAY} 09:30`],
    );

    const res = await request(app).get(`/api/doctors/${id}/slots`).query({ date: MONDAY });
    const byTime = Object.fromEntries(res.body.slots.map((s) => [s.startsAt, s.status]));
    expect(byTime['09:30']).toBe('booked');
    expect(byTime['09:00']).toBe('open');
  });

  it('404 unknown doctor; 400 bad date', async () => {
    const missing = await request(app)
      .get('/api/doctors/999999/slots')
      .query({ date: MONDAY });
    expect(missing.status).toBe(404);

    const badDate = await request(app)
      .get(`/api/doctors/${doctorId}/slots`)
      .query({ date: 'tomorrow' });
    expect(badDate.status).toBe(400);
    expect(badDate.body.error.code).toBe('VALIDATION_ERROR');
  });
});
