import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { createApp } from '../../src/app.js';
import { getTestPool, testConfig, resetDb, closeTestPool } from '../helpers.js';

const pool = await getTestPool();
const config = testConfig();
const app = createApp({ config, pool });

function tokenFor(id, role) {
  return jwt.sign({ sub: String(id), role }, config.jwtSecret, { algorithm: 'HS256' });
}

let adminCookie;

beforeAll(async () => {
  await resetDb();
  const { rows } = await pool.query(
    `INSERT INTO users (role, email, password_hash, name)
     VALUES ('admin', 'admin@test', 'x', 'Admin') RETURNING id`,
  );
  adminCookie = [`hcm_session=${tokenFor(rows[0].id, 'admin')}`];
});

afterAll(closeTestPool);

const DOCTOR = {
  email: 'dr.mehta@ashgrove.health',
  name: 'Dr. Meera Mehta',
  specialisation: 'General Medicine',
  workingDays: [1, 2, 3, 4, 5],
  startsAt: '09:00',
  endsAt: '13:00',
  slotMinutes: 20,
};

describe('admin doctor management (role-gated)', () => {
  it('403 FORBIDDEN for a patient token', async () => {
    await resetDb();
    const patientRes = await request(app).post('/api/auth/register').send({
      email: 'patient@ashgrove.health', name: 'P', password: 'long-enough-1',
    });
    const pid = patientRes.body.user.id;
    const res = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', `hcm_session=${tokenFor(pid, 'patient')}`)
      .send(DOCTOR);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('creates a doctor (users row + profile, hashed password)', async () => {
    await resetDb();
    const res = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminCookie)
      .send({ ...DOCTOR, password: 'doctor-pass-1' });

    expect(res.status).toBe(201);
    expect(res.body.doctor).toMatchObject({
      email: DOCTOR.email,
      name: DOCTOR.name,
      specialisation: 'General Medicine',
      startsAt: '09:00',
      endsAt: '13:00',
      slotMinutes: 20,
    });

    // The doctor can actually log in.
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: DOCTOR.email, password: 'doctor-pass-1' });
    expect(login.status).toBe(200);
    expect(login.body.user.role).toBe('doctor');
  });

  it('validates schedule fields (slotMinutes>0, endsAt>startsAt, day range)', async () => {
    await resetDb();
    const cases = [
      { ...DOCTOR, slotMinutes: 0 },
      { ...DOCTOR, startsAt: '14:00', endsAt: '10:00' },
      { ...DOCTOR, workingDays: [0, 7] },
      { ...DOCTOR, startsAt: '9am' },
    ];
    for (const body of cases) {
      const res = await request(app)
        .post('/api/admin/doctors')
        .set('Cookie', adminCookie)
        .send(body);
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe('VALIDATION_ERROR');
    }
  });

  it('lists doctors with their schedules', async () => {
    await resetDb();
    await request(app).post('/api/admin/doctors').set('Cookie', adminCookie)
      .send({ ...DOCTOR, password: 'doctor-pass-1' });

    const res = await request(app).get('/api/admin/doctors').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.doctors).toHaveLength(1);
    expect(res.body.doctors[0].specialisation).toBe('General Medicine');
  });

  it('PATCH updates schedule fields only for existing doctor', async () => {
    await resetDb();
    const created = await request(app).post('/api/admin/doctors').set('Cookie', adminCookie)
      .send({ ...DOCTOR, password: 'doctor-pass-1' });
    const id = created.body.doctor.userId;

    const patch = await request(app)
      .patch(`/api/admin/doctors/${id}`)
      .set('Cookie', adminCookie)
      .send({ slotMinutes: 30, endsAt: '15:00' });
    expect(patch.status).toBe(200);
    expect(patch.body.doctor.slotMinutes).toBe(30);
    expect(patch.body.doctor.endsAt).toBe('15:00');
    expect(patch.body.doctor.specialisation).toBe('General Medicine');

    const missing = await request(app)
      .patch('/api/admin/doctors/999999')
      .set('Cookie', adminCookie)
      .send({ slotMinutes: 30 });
    expect(missing.status).toBe(404);
  });

  it('DELETE removes the doctor; unknown id is 404', async () => {
    await resetDb();
    const created = await request(app).post('/api/admin/doctors').set('Cookie', adminCookie)
      .send({ ...DOCTOR, password: 'doctor-pass-1' });
    const id = created.body.doctor.userId;

    expect((await request(app).delete(`/api/admin/doctors/${id}`).set('Cookie', adminCookie)).status).toBe(200);
    const list = await request(app).get('/api/admin/doctors').set('Cookie', adminCookie);
    expect(list.body.doctors).toHaveLength(0);

    const again = await request(app).delete(`/api/admin/doctors/${id}`).set('Cookie', adminCookie);
    expect(again.status).toBe(404);
  });
});
