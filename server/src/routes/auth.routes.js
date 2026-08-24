import { Router } from 'express';
import jwt from 'jsonwebtoken';
import { AppError } from '../lib/errors.js';
import { isThrottled, recordFailure, recordSuccess } from '../lib/throttle.js';
import { login, registerPatient, publicUser } from '../services/auth.service.js';
import { requireAuth } from '../middleware/auth.js';

const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60;

export function authRoutes({ query, config }) {
  const router = Router();

  const cookieOptions = {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: SESSION_TTL_SECONDS * 1000,
    secure: process.env.NODE_ENV === 'production',
  };

  function sessionToken(user) {
    return jwt.sign({ sub: String(user.id), role: user.role }, config.jwtSecret, {
      algorithm: 'HS256',
      expiresIn: SESSION_TTL_SECONDS,
    });
  }

  router.post('/register', async (req, res, next) => {
    try {
      const user = await registerPatient(query, req.body);
      res.status(201).json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/login', async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email : '';
      const ip = req.ip ?? 'unknown';

      const throttled = isThrottled(email, ip);
      if (throttled) {
        throw new AppError(
          429,
          'RATE_LIMITED',
          `Too many failed attempts. Try again in ${Math.ceil(throttled.retryAfterMs / 60000)} minutes.`,
        );
      }

      try {
        var user = await login(query, req.body);
      } catch (err) {
        if (err.status === 401) recordFailure(email, ip);
        throw err;
      }

      recordSuccess(email, ip);
      res.cookie(config.cookieName, sessionToken(user), cookieOptions);
      res.json({ user: publicUser(user) });
    } catch (err) {
      next(err);
    }
  });

  router.post('/logout', (_req, res) => {
    res.clearCookie(config.cookieName, { path: '/' });
    res.json({ ok: true });
  });

  router.get('/me', requireAuth(config), async (req, res, next) => {
    try {
      const { rows } = await query(
        `SELECT id, role, email, name, phone, created_at FROM users WHERE id = $1`,
        [req.user.id],
      );
      if (rows.length === 0) {
        throw new AppError(401, 'UNAUTHORIZED', 'Authentication required.');
      }
      res.json({ user: publicUser(rows[0]) });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
