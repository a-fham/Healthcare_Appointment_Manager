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

beforeAll(async () => {
  await resetDb();
});

describe('GET /api/admin/health', () => {
  it('reports queue depths and dead-letters; role-gated to admins', async () => {
    const hash = (await import('../src/lib/passwords.js')).hashPassword;
    await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('admin','healthadmin@t.health',$1,'A')`,
      [await hash('Passw0rd!123')],
    );
    await query(
      `INSERT INTO users (role,email,password_hash,name) VALUES ('patient','healthpat@t.health','x','P')`,
    );

    await query(
      `INSERT INTO email_queue (to_email, template, payload, status, last_error)
       VALUES ('a@t.health','booking_confirmation','{}','failed','smtp down')`,
    );
    await query(
      `INSERT INTO email_queue (to_email, template, payload)
       VALUES ('b@t.health','cancellation','{}')`,
    );
    await query(
      `INSERT INTO job_state (name, last_run_at) VALUES ('tick','2026-08-24T08:00:00Z')
       ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
    );

    const loginRes = await request(app)
      .post('/api/auth/login')
      .send({ email: 'healthadmin@t.health', password: 'Passw0rd!123' });
    expect(loginRes.status).toBe(200);
    const adminCookie = loginRes.headers['set-cookie']?.[0];
    expect(typeof adminCookie).toBe('string');

    const res = await request(app).get('/api/admin/health').set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    expect(res.body.emails.pending).toBe(1);
    expect(res.body.emails.failed).toBe(1);
    expect(typeof res.body.calendar.pending).toBe('number');
    expect(typeof res.body.holds.active).toBe('number');
    expect(typeof res.body.summaries.pending).toBe('number');
    expect(new Date(res.body.lastTickAt).toISOString()).toBe('2026-08-24T08:00:00.000Z');

    // Patients cannot see operational health.
    const patEmail = `hp2-${Date.now()}@t.health`;
    await request(app)
      .post('/api/auth/register')
      .send({ email: patEmail, name: 'P2', password: 'long-enough-1' });
    const patRes = await request(app)
      .post('/api/auth/login')
      .send({ email: patEmail, password: 'long-enough-1' });
    expect(patRes.status).toBe(200);
    const patCookie = patRes.headers['set-cookie']?.[0];
    expect(typeof patCookie).toBe('string');
    const asPatient = await request(app)
      .get('/api/admin/health')
      .set('Cookie', patCookie);
    expect(asPatient.status).toBe(403);
  });
});
