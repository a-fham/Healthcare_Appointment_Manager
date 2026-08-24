import { Router } from 'express';
import { AppError } from '../lib/errors.js';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { recordVisitNotes } from '../services/notes.service.js';
import { doctorQueue } from '../services/views.service.js';
import { dateToDateStr } from '../lib/time.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function doctorRoutes({ pool, query, config, now = () => new Date() }) {
  const router = Router();
  const doctorOnly = [requireAuth(config), requireRole('doctor')];

  router.post('/appointments/:id/notes', ...doctorOnly, async (req, res, next) => {
    try {
      const id = req.params.id;
      if (!UUID_RE.test(id)) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
      await recordVisitNotes(pool, {
        appointmentId: id,
        doctorId: req.user.id,
        body: req.body,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/doctors/me/queue', ...doctorOnly, async (req, res, next) => {
    try {
      const date = req.query.date ?? dateToDateStr(now());
      res.json(await doctorQueue(query, { doctorId: req.user.id, date }));
    } catch (err) {
      next(err);
    }
  });

  return router;
}
