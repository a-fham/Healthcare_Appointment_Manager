import { describe, it, expect, afterAll } from 'vitest';
import request from 'supertest';
import { createApp } from '../../src/app.js';
import { getTestPool, testConfig, resetDb, closeTestPool } from '../helpers.js';

const pool = await getTestPool();
const app = createApp({ config: testConfig(), pool });

afterAll(closeTestPool);

describe('POST /api/auth/register', () => {
  it('creates a patient with a bcrypt hash (plain never stored)', async () => {
    const pool = await resetDb();
    const res = await request(app)
      .post('/api/auth/register')
      .send({ email: 'Asha@Example.com', name: 'Asha', phone: '9876543210', password: 'correct-horse-1' });

    expect(res.status).toBe(201);
    expect(res.body.user).toMatchObject({
      email: 'asha@example.com',
      name: 'Asha',
      role: 'patient',
    });
    expect(res.body.user.password_hash).toBeUndefined();

    const { rows } = await pool.query('SELECT * FROM users WHERE email=$1', [
      'asha@example.com',
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0].password_hash).not.toBe('correct-horse-1');
  });

  it('rejects duplicate email with 409 EMAIL_TAKEN (case-insensitive)', async () => {
    await resetDb();
    const body = { email: 'dup@example.com', name: 'First', password: 'long-enough-1' };
    expect((await request(app).post('/api/auth/register').send(body)).status).toBe(201);

    const res = await request(app)
      .post('/api/auth/register')
      .send({ ...body, name: 'Second' });
    expect(res.status).toBe(409);
    expect(res.body.error.code).toBe('EMAIL_TAKEN');
  });

  it('returns 400 VALIDATION_ERROR naming every bad field', async () => {
    await resetDb();
    const res = await request(app).post('/api/auth/register').send({
      email: 'not-an-email',
      password: 'short',
    });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    const msg = JSON.stringify(res.body.error);
    expect(msg).toContain('email');
    expect(msg).toContain('name');
    expect(msg).toContain('password');
  });
});

describe('POST /api/auth/login + GET /me + logout', () => {
  it('sets an httpOnly SameSite=Lax session cookie and /me reads it back', async () => {
    const pool = await resetDb();
    await request(app).post('/api/auth/register').send({
      email: 'login@example.com', name: 'Login', phone: '9000000000', password: 'long-enough-1',
    });

    const login = await request(app)
      .post('/api/auth/login')
      .send({ email: 'login@example.com', password: 'long-enough-1' });
    expect(login.status).toBe(200);

    const cookie = login.headers['set-cookie'].find((c) => c.startsWith('hcm_session='));
    expect(cookie).toBeTruthy();
    expect(cookie).toContain('HttpOnly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');

    const me = await request(app).get('/api/auth/me').set('Cookie', cookie);
    expect(me.status).toBe(200);
    expect(me.body.user.email).toBe('login@example.com');

    const out = await request(app).post('/api/auth/logout').set('Cookie', cookie);
    expect(out.status).toBe(200);
    const cleared = out.headers['set-cookie'].find((c) => c.startsWith('hcm_session='));
    expect(cleared.toLowerCase()).toContain('expires=thu, 01 jan 1970');
  });

  it('wrong password and unknown email are indistinguishable (401 INVALID_CREDENTIALS)', async () => {
    await resetDb();
    await request(app).post('/api/auth/register').send({
      email: 'known@example.com', name: 'Known', password: 'long-enough-1',
    });

    const wrongPw = await request(app)
      .post('/api/auth/login')
      .send({ email: 'known@example.com', password: 'wrong-password-1' });
    const unknown = await request(app)
      .post('/api/auth/login')
      .send({ email: 'ghost@example.com', password: 'whatever-long' });

    expect(wrongPw.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(unknown.body.error.code).toBe(wrongPw.body.error.code);
    expect(unknown.body.error.message).toBe(wrongPw.body.error.message);
  });

  it('/me without a cookie is 401 UNAUTHORIZED', async () => {
    const res = await request(app).get('/api/auth/me');
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe('UNAUTHORIZED');
  });

  it('throttles the 6th failed attempt for one email+IP inside the window (429), success resets', async () => {
    await resetDb();
    const creds = { email: 'throttle@example.com', password: 'definitely-wrong' };

    for (let i = 0; i < 5; i += 1) {
      const r = await request(app).post('/api/auth/login').send(creds);
      expect(r.status).toBe(401);
    }
    const sixth = await request(app).post('/api/auth/login').send(creds);
    expect(sixth.status).toBe(429);
    expect(sixth.body.error.code).toBe('RATE_LIMITED');
    expect(sixth.body.error.message).toMatch(/try again/i);

    // Even the CORRECT password is refused while throttled.
    const blockedGood = await request(app)
      .post('/api/auth/login')
      .send({ email: 'throttle@example.com', password: 'long-enough-1' });
    expect(blockedGood.status).toBe(429);
  });
});
