import { describe, it, expect } from 'vitest';
import express from 'express';
import jwt from 'jsonwebtoken';
import request from 'supertest';
import { requireAuth, requireRole } from '../../src/middleware/auth.js';

const SECRET = 'test-jwt-secret-not-for-production';
const COOKIE = 'hcm_session';

function sign(payload, opts = {}) {
  return jwt.sign(payload, SECRET, { expiresIn: '7d', ...opts });
}

function probeApp() {
  const app = express();
  app.get('/any', requireAuth({ jwtSecret: SECRET, cookieName: COOKIE }), (req, res) =>
    res.json({ user: req.user }),
  );
  app.get(
    '/patient-only',
    requireAuth({ jwtSecret: SECRET, cookieName: COOKIE }),
    requireRole('patient'),
    (_req, res) => res.json({ ok: true }),
  );
  app.use((err, _req, res, _next) => {
    res.status(err.status ?? 500).json({ error: { code: err.code ?? 'INTERNAL', message: err.message } });
  });
  return app;
}

describe('requireAuth / requireRole guards', () => {
  it('attaches {id, role} from a valid cookie and calls the handler', async () => {
    const res = await request(probeApp())
      .get('/any')
      .set('Cookie', `${COOKIE}=${sign({ sub: '42', role: 'patient' })}`);
    expect(res.status).toBe(200);
    expect(res.body.user).toEqual({ id: 42, role: 'patient' });
  });

  it('401 without cookie; 401 with garbage; 401 for expired token', async () => {
    const agent = request(probeApp());
    expect((await agent.get('/any')).status).toBe(401);
    expect(
      (await agent.get('/any').set('Cookie', `${COOKIE}=not-a-jwt`)).status,
    ).toBe(401);
    const expired = await agent
      .get('/any')
      .set('Cookie', `${COOKIE}=${sign({ sub: '42', role: 'patient' }, { expiresIn: '-10s' })}`);
    expect(expired.status).toBe(401);
    expect(expired.body.error.code).toBe('UNAUTHORIZED');
  });

  it('401 when token signed with wrong secret (forgery)', async () => {
    const forged = jwt.sign({ sub: '42', role: 'admin' }, 'attacker-secret');
    const res = await request(probeApp()).get('/any').set('Cookie', `${COOKIE}=${forged}`);
    expect(res.status).toBe(401);
  });

  it('requireRole: doctor token on patient route → 403 FORBIDDEN', async () => {
    const res = await request(probeApp())
      .get('/patient-only')
      .set('Cookie', `${COOKIE}=${sign({ sub: '7', role: 'doctor' })}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe('FORBIDDEN');
  });

  it('requireRole: matching role passes', async () => {
    const res = await request(probeApp())
      .get('/patient-only')
      .set('Cookie', `${COOKIE}=${sign({ sub: '7', role: 'patient' })}`);
    expect(res.status).toBe(200);
  });
});
