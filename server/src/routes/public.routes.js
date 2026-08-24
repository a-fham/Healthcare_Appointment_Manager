import { Router } from 'express';
import { AppError, validationError } from '../lib/errors.js';
import { getDoctor, listDoctorsPublic } from '../services/doctors.service.js';
import { computeSlots } from '../services/slots.service.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const SORTS = new Set(['name', 'specialisation']);

export function clinicNowStr(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0');
  return `${date.getFullYear()}-${p(date.getMonth() + 1)}-${p(date.getDate())} ${p(date.getHours())}:${p(date.getMinutes())}`;
}

export function publicRoutes({ query, nowStr = () => clinicNowStr() }) {
  const router = Router();

  router.get('/doctors', async (req, res, next) => {
    try {
      const sortRaw = String(req.query.sort ?? '').toLowerCase();
      const doctors = await listDoctorsPublic(query, {
        specialisation: req.query.specialisation,
        sort: SORTS.has(sortRaw) ? sortRaw : undefined,
      });
      res.json({ doctors });
    } catch (err) {
      next(err);
    }
  });

  router.get('/doctors/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
      res.json({ doctor: await getDoctor(query, id) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/doctors/:id/slots', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
      const date = String(req.query.date ?? '');
      if (!DATE_RE.test(date)) throw validationError('date: must be YYYY-MM-DD');

      const doctor = await getDoctor(query, id);

      const leaves = await query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS d FROM leave_days WHERE doctor_id = $1`,
        [id],
      );
      const appts = await query(
        `SELECT to_char(scheduled_at, 'HH24:MI') AS t, status
         FROM appointments
         WHERE doctor_id = $1 AND scheduled_at::date = $2::date
           AND status IN ('confirmed', 'held')`,
        [id, date],
      );

      const DISPLAY_STATUS = { confirmed: 'booked', held: 'held' };
      const takenMap = new Map(
        appts.rows.map((r) => [r.t, DISPLAY_STATUS[r.status] ?? 'booked']),
      );
      const leaveSet = new Set(leaves.rows.map((r) => r.d));
      const slots = computeSlots(doctor, date, takenMap, leaveSet, nowStr());
      res.json({ doctorId: id, date, slots });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
