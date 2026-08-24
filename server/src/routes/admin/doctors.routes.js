import { Router } from 'express';
import { AppError } from '../../lib/errors.js';
import {
  createDoctor,
  listDoctors,
  getDoctor,
  updateDoctor,
  deleteDoctor,
} from '../../services/doctors.service.js';
import { previewLeave, markLeave } from '../../services/leave.service.js';
import { healthSnapshot } from '../../services/health.service.js';

function doctorIdParam(req) {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
  return id;
}

export function adminDoctorRoutes({ pool, query }) {
  const router = Router();

  router.get('/health', async (_req, res, next) => {
    try {
      res.json(await healthSnapshot(query));
    } catch (err) {
      next(err);
    }
  });

  router.post('/doctors', async (req, res, next) => {
    try {
      res.status(201).json({ doctor: await createDoctor(pool, req.body) });
    } catch (err) {
      next(err);
    }
  });

  router.get('/doctors', async (_req, res, next) => {
    try {
      res.json({ doctors: await listDoctors(query) });
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

  router.patch('/doctors/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
      res.json({ doctor: await updateDoctor(pool, id, req.body) });
    } catch (err) {
      next(err);
    }
  });

  router.delete('/doctors/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isInteger(id)) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
      await deleteDoctor(query, id);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  });

  router.get('/doctors/:id/leave-preview', async (req, res, next) => {
    try {
      res.json(await previewLeave(query, { doctorId: doctorIdParam(req), date: req.query.date }));
    } catch (err) {
      next(err);
    }
  });

  router.post('/doctors/:id/leave', async (req, res, next) => {
    try {
      const result = await markLeave(pool, {
        doctorId: doctorIdParam(req),
        date: req.body?.date,
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
