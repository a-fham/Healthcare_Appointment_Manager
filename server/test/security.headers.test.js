import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import request from 'supertest';
import jwt from 'jsonwebtoken';
import { loadConfig } from '../src/config.js';
import { getPool } from '../src/db/pool.js';
import { runMigrations, migrationsDir } from '../src/db/migrate.js';
import { createApp } from '../src/app.js';

const config = loadConfig({
  DATABASE_URL: process.env.AGENT_DB_URL ?? 'postgres://postgres:postgres@localhost:5432/hcm_agent_b',
  JWT_SECRET: 'test-jwt-secret-not-for-production',
  JOB_SECRET: 'test-job-secret',
});
const pool = getPool(config);
await runMigrations(pool, migrationsDir);

let NOW = new Date('2026-08-20T08:00:00');
const app = createApp({ config, pool, now: () => NOW });

const COOKIE = config.cookieName;
const sign = (payload) => jwt.sign(payload, config.jwtSecret, { algorithm: 'HS256' });

let patientCookie;
beforeAll(async () => {
  await pool.query(
    `TRUNCATE appointment_events, calendar_events, notification_log,
            email_queue, post_visit_summaries, visit_notes,
            pre_visit_summaries, appointments, leave_days, doctors, users
     RESTART IDENTITY CASCADE`,
  );
  const res = await request(app).post('/api/auth/register').send({
    email: 'sec.pat@ashgrove.health',
    name: 'Sec Pat',
    password: 'long-enough-1',
  });
  expect(res.status).toBe(201);
  const login = await request(app).post('/api/auth/login').send({
    email: 'sec.pat@ashgrove.health',
    password: 'long-enough-1',
  });
  patientCookie = login.headers['set-cookie'][0].split(';')[0];
});

afterAll(async () => {
  await pool.end();
});

describe('security headers on every response', () => {
  const probe = async (path) => (await request(app).get(path)).headers;

  it.each(['/api/doctors', '/api/definitely-not-a-route', '/api/auth/me'])('%s carries the hardening set', async (path) => {
    const h = await probe(path);
    expect(h['x-content-type-options']).toBe('nosniff');
    expect(h['x-frame-options']).toBe('DENY');
    expect(h['referrer-policy']).toBe('no-referrer');
    expect(h['permissions-policy']).toContain('camera=()');
    expect(h['cross-origin-opener-policy']).toBe('same-origin');
    expect(h['x-powered-by']).toBeUndefined();
  });

  it('no HSTS over plain HTTP (only set when req.secure)', async () => {
    const h = await probe('/api/doctors');
    expect(h['strict-transport-security']).toBeUndefined();
  });

  it('error responses never leak stack traces or internals', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'not-an-email', name: '', password: 'x' });
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toMatch(/at\s+.*\(.*:\d+/); // no stack frames
    expect(JSON.stringify(res.body)).not.toContain('node_modules');
  });
});

describe('body limits and parser hardening', () => {
  it('oversized JSON body → 413 PAYLOAD_TOO_LARGE, server stays healthy', async () => {
    const big = { symptomsText: 'x'.repeat(200 * 1024), severity: 'mild', durationText: '1 day' };
    const res = await request(app).post('/api/auth/register').send(big);
    expect(res.status).toBe(413);
    expect(res.body.error.code).toBe('PAYLOAD_TOO_LARGE');

    const next = await request(app).get('/api/doctors');
    expect(next.status).toBe(200); // connection/process unharmed
  });

  it('malformed JSON body → 400 VALIDATION_ERROR, no crash', async () => {
    const res = await request(app)
      .post('/api/auth/register')
      .set('Content-Type', 'application/json')
      .send('{"email": "broken');
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
  });

  it('form-encoded body where JSON expected → rejected safely', async () => {
    const res = await request(app)
      .post('/api/auth/login')
      .set('Content-Type', 'application/x-www-form-urlencoded')
      .send('email=a@b.c&password=x');
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(res.status).toBeLessThan(500);
  });

  it('unknown route → JSON NOT_FOUND envelope (never HTML)', async () => {
    const res = await request(app).get('/no/such/page');
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: { code: 'NOT_FOUND', message: expect.any(String) } });
    expect(res.type).toMatch(/json/);
  });
});

describe('injection smoke tests', () => {
  let docId;
  beforeAll(async () => {
    const adminC = `${COOKIE}=${sign({ sub: '999', role: 'admin' })}`;
    const res = await request(app)
      .post('/api/admin/doctors')
      .set('Cookie', adminC)
      .send({
        email: "sec.doc@ashgrove.health'; DROP TABLE appointments;--",
        name: "Dr. '); DELETE FROM users;--",
        password: 'doctor-pass-1',
        specialisation: 'General Medicine',
        workingDays: [1],
        startsAt: '09:00',
        endsAt: '11:00',
        slotMinutes: 20,
      });
    // Either created (parameterized storage of hostile text) or rejected by
    // validation , both are safe; tables must survive either way.
    if (res.status === 201) docId = res.body.doctor.userId;
  });

  it('hostile SQL payloads leave every table intact', async () => {
    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: "admin@ashgrove.health' OR '1'='1", password: "' OR '1'='1" });
    expect([401, 422, 400]).toContain(login.status);

    const appts = await pool.query(`SELECT count(*)::int n FROM appointments`);
    expect(appts.rows[0].n).toBeTypeOf('number'); // table still exists

    const docs = await request(app).get('/api/doctors');
    expect(docs.status).toBe(200);
  });

  it("script-tag symptom text round-trips as inert JSON data", async () => {
    // Storage-level XSS safety: the API stores text verbatim and returns JSON ,
    // execution context is the browser's job to prevent; assert no HTML echo.
    const hostile = '<script>alert(1)</script> chest pain';
    const res = await request(app).post('/api/auth/register').send({
      email: 'sec.xss@ashgrove.health',
      name: hostile,
      password: 'long-enough-1',
    });
    if (res.status === 201) {
      expect(res.body.user.name).toBe(hostile); // raw string, not encoded/transformed
      expect(res.type).toMatch(/json/);
    }
  });

  it('doctor id parameter is coerced numerically (no injection via params)', async () => {
    const res = await request(app).get(`/api/doctors/${encodeURIComponent('1; DROP TABLE users')}`);
    expect([404, 400]).toContain(res.status);
    const users = await pool.query(`SELECT count(*)::int n FROM users`);
    expect(users.rows[0].n).toBeGreaterThan(0);
  });
  void docId;
});

describe('session token hardening', () => {
  const protectedGet = (cookieVal) =>
    request(app).get('/api/my/appointments').set('Cookie', cookieVal);

  it('missing cookie → 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/my/appointments');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('garbage cookie value → 401, no crash', async () => {
    const res = await protectedGet(`${COOKIE}=totally-not-a-jwt`);
    expect(res.status).toBe(401);
  });

  it('tampered payload (flipped role character) breaks the signature → 401', async () => {
    const [header, payload] = sign({ sub: '1', role: 'patient' }).split('.');
    const forgedPayload = Buffer.from(JSON.stringify({ sub: '1', role: 'admin' })).toString('base64url');
    const res = await protectedGet(`${COOKIE}=${header}.${forgedPayload}.fakesig`);
    expect(res.status).toBe(401);
  });

  it('token signed with a foreign secret → 401', async () => {
    const alien = jwt.sign({ sub: '1', role: 'patient' }, 'attacker-secret', { algorithm: 'HS256' });
    const res = await protectedGet(`${COOKIE}=${alien}`);
    expect(res.status).toBe(401);
  });

  it('expired token → 401', async () => {
    const stale = jwt.sign({ sub: '1', role: 'patient' }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: -10,
    });
    const res = await protectedGet(`${COOKIE}=${stale}`);
    expect(res.status).toBe(401);
  });

  it('alg:none token → 401 (HS256 pinned)', async () => {
    const b64url = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const noneToken = `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url({
      sub: '1',
      role: 'admin',
    })}.`;
    const res = await protectedGet(`${COOKIE}=${noneToken}`);
    expect(res.status).toBe(401);
  });

  it('token missing sub or with non-string role → 401 even under valid signature', async () => {
    const weirdA = sign({ role: 'patient' }); // no sub
    expect((await protectedGet(`${COOKIE}=${weirdA}`)).status).toBe(401);
    const weirdB = sign({ sub: '1', role: 42 });
    expect((await protectedGet(`${COOKIE}=${weirdB}`)).status).toBe(401);
  });

  it('a validly-signed admin-role token does grant admin routes (server mints roles at login; documented tradeoff)', async () => {
    const adminC = `${COOKIE}=${sign({ sub: '999', role: 'admin' })}`;
    const res = await request(app).get('/api/admin/doctors').set('Cookie', adminC);
    expect(res.status).toBe(200);
    // The flip side: patients cannot mint themselves a higher role because
    // tokens are only issued by /api/auth/login from DB-verified credentials.
    const patientAdminTry = await request(app)
      .get('/api/admin/doctors')
      .set('Cookie', patientCookie);
    expect(patientAdminTry.status).toBe(403);
  });
});
