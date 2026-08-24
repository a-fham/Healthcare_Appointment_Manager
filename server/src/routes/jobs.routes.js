import { Router } from 'express';
import { runTick } from '../services/tick.js';
import { makeQuery } from '../db/pool.js';

export function jobsRoutes({ pool, config, now, sendEmail, cal }) {
  const router = Router();

  router.post('/jobs/tick', async (req, res, next) => {
    try {
      const secret = req.header('x-job-secret');
      if (!config.jobSecret || secret !== config.jobSecret) {
        return res
          .status(403)
          .json({ error: { code: 'FORBIDDEN', message: 'Invalid job secret.' } });
      }

      const result = await runTick({
        query: makeQuery(pool),
        pool,
        now,
        sendEmail,
        cal,
        llmDeps: { fetchImpl: globalThis.fetch, cfg: config },
      });
      res.json(result);
    } catch (err) {
      next(err);
    }
  });

  return router;
}
