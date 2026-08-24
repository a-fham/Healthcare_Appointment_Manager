import { processEmails } from './workers/email.worker.js';
import { processCalendarEvents } from './workers/calendar.worker.js';
import { expireHolds } from './workers/hold.sweeper.js';
import { scheduleMedicationReminders } from './workers/reminders.js';
import { regeneratePendingSummaries } from './llm/regenerate.js';
import {
  generatePreVisitContent,
  generatePostVisitContent,
} from './llm/generate.js';

/**
 * One scheduler beat (architecture doc §3/§7/§9). Every worker is idempotent
 * and claim-based, so ticks may overlap safely , locally via node-cron,
 * in production via an external cron hitting POST /api/jobs/tick.
 *
 * deps: { query, pool, now, sendEmail, cal, llmDeps }
 */
export async function runTick(deps) {
  const { query, pool, now, sendEmail, cal, llmDeps } = deps;

  const holdsExpired = await expireHolds({ query, now, pool });
  const emails = await processEmails({ query, now, sendEmail, pool });
  const calendar = await processCalendarEvents({ query, now, cal, pool });
  const reminders = await scheduleMedicationReminders({ query, now });

  let summaries = { attempted: 0 };
  if (pool) {
    // The adapters return {content, source, model}; the regenerator speaks
    // {ok, payload, model} with a fast path for deterministic fallbacks.
    const asOutcome = (r) =>
      r.source === 'fallback'
        ? { ok: false, fallbackNow: r.content }
        : { ok: true, payload: r.content, model: r.model };
    summaries = await regeneratePendingSummaries({
      query: pool.query.bind(pool),
      now,
      pool,
      generatePre: async (row) =>
        asOutcome(await generatePreVisitContent(llmDeps, row.symptoms_text)),
      generatePost: async (row) =>
        asOutcome(await generatePostVisitContent(llmDeps, row.clinical_notes, row.prescription)),
    });
  }

  const nowDate = now();
  await query(
    `INSERT INTO job_state (name, last_run_at) VALUES ('tick', $1)
     ON CONFLICT (name) DO UPDATE SET last_run_at = EXCLUDED.last_run_at`,
    [nowDate],
  );

  return { holdsExpired, emails, calendar, reminders, summaries };
}
