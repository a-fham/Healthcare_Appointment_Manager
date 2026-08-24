import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { myAppointments } from '../services/views.service.js';

export function patientRoutes({ query, config }) {
  const router = Router();

  router.get(
    '/my/appointments',
    requireAuth(config),
    requireRole('patient'),
    async (req, res, next) => {
      try {
        res.json(await myAppointments(query, { patientId: req.user.id }));
      } catch (err) {
        next(err);
      }
    },
  );

  return router;
}
