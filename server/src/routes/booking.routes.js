import { Router } from 'express';
import { requireAuth, requireRole } from '../middleware/auth.js';
import { AppError } from '../lib/errors.js';
import { createHold, confirmBooking, cancelAppointment, rescheduleAppointment } from '../services/booking.service.js';

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function bookingRoutes({ pool, config, now = () => new Date() }) {
  const router = Router();
  const patientOnly = [requireAuth(config), requireRole('patient')];

  router.post('/doctors/:id/slots/hold', ...patientOnly, async (req, res, next) => {
    try {
      const doctorId = Number(req.params.id);
      const hold = await createHold(
        pool,
        { patientId: req.user.id, doctorId, scheduledAt: req.body?.scheduledAt },
        { now, holdMinutes: config.holdMinutes },
      );
      res.status(201).json({
        appointment: {
          id: hold.id,
          status: hold.status,
          scheduledAt: hold.scheduledAt,
          doctorId: hold.doctorId,
          expiresAt: hold.expiresAt,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.post('/appointments/:id/confirm', ...patientOnly, async (req, res, next) => {
    try {
      const appointmentId = UUID_RE.test(req.params.id) ? req.params.id : null;
      if (!appointmentId) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
      const result = await confirmBooking(
        pool,
        {
          appointmentId,
          patientId: req.user.id,
          symptomsText: req.body?.symptomsText,
          severity: req.body?.severity,
          durationText: req.body?.durationText,
        },
        { now },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.delete('/appointments/:id', requireAuth(config), requireRole('patient', 'admin'), async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
      const result = await cancelAppointment(
        pool,
        { appointmentId: req.params.id, actorId: req.user.id, actorRole: req.user.role },
        { now },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  router.patch('/appointments/:id/reschedule', ...patientOnly, async (req, res, next) => {
    try {
      if (!UUID_RE.test(req.params.id)) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
      const result = await rescheduleAppointment(
        pool,
        {
          appointmentId: req.params.id,
          patientId: req.user.id,
          newScheduledAt: req.body?.newScheduledAt,
        },
        { now, holdMinutes: config.holdMinutes },
      );
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
