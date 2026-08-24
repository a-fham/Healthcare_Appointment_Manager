import express from 'express';
import path from 'node:path';
import { makeQuery } from './db/pool.js';
import { securityHeaders } from './middleware/security.js';
import { requireAuth, requireRole } from './middleware/auth.js';
import { AppError } from './lib/errors.js';
import { authRoutes } from './routes/auth.routes.js';
import { adminDoctorRoutes } from './routes/admin/doctors.routes.js';
import { publicRoutes } from './routes/public.routes.js';
import { bookingRoutes } from './routes/booking.routes.js';
import { doctorRoutes } from './routes/doctor.routes.js';
import { patientRoutes } from './routes/patient.routes.js';
import { jobsRoutes } from './routes/jobs.routes.js';
import { makeSendEmail } from './lib/mailer.js';

export function createApp({
  config,
  pool,
  nowStr,
  now,
  sendEmail: sendEmailOverride,
  cal: calOverride,
  clientDist,
}) {
  const app = express();
  const query = pool ? makeQuery(pool) : null;

  app.disable('x-powered-by');
  app.use(securityHeaders);
  app.use(express.json({ limit: '100kb' }));

  if (config && query) {
    app.use('/api', publicRoutes({ query, nowStr }));
    app.use('/api/auth', authRoutes({ query, config }));
    app.use('/api', bookingRoutes({ pool, config, now }));
    app.use('/api', doctorRoutes({ pool, query, config, now }));
    app.use('/api', patientRoutes({ query, config }));
    app.use(
      '/api',
      jobsRoutes({
        pool,
        config,
        now: now ?? (() => new Date()),
        sendEmail: sendEmailOverride ?? makeSendEmail(config),
        cal: calOverride ?? {
          createEvent: async () => {
            throw new Error('calendar provider not configured');
          },
          deleteEvent: async () => {
            throw new Error('calendar provider not configured');
          },
        },
      }),
    );
    app.use(
      '/api/admin',
      requireAuth(config),
      requireRole('admin'),
      adminDoctorRoutes({ query, pool }),
    );
  }

  // Built SPA (client/dist) is served by the same process in production.
  if (clientDist) {
    app.use(
      express.static(clientDist, {
        index: false,
        setHeaders(res, filePath) {
          if (filePath.endsWith('.html')) {
            res.setHeader('Cache-Control', 'no-store');
          } else if (/[/\\]assets[/\\]/.test(filePath)) {
            res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          }
        },
      }),
    );
    app.get(/^\/(?!api\/).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-store');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use((_req, _res, next) => next(new AppError(404, 'NOT_FOUND', 'Resource not found.')));

  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, _next) => {
    if (err instanceof AppError) {
      return res.status(err.status).json({ error: { code: err.code, message: err.message } });
    }
    if (err?.type === 'entity.too.large') {
      return res
        .status(413)
        .json({ error: { code: 'PAYLOAD_TOO_LARGE', message: 'Request body too large.' } });
    }
    if (err?.type === 'entity.parse.failed') {
      return res
        .status(400)
        .json({ error: { code: 'VALIDATION_ERROR', message: 'Malformed JSON body.' } });
    }
    console.error(
      JSON.stringify({
        level: 'error',
        method: req.method,
        path: req.originalUrl,
        message: err.message,
        stack: err.stack,
        at: new Date().toISOString(),
      }),
    );
    return res.status(500).json({ error: { code: 'INTERNAL', message: 'Something went wrong.' } });
  });

  return app;
}
