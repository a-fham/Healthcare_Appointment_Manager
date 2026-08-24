import { fallbackPreVisit, fallbackPostVisit } from './prompts.js';
import { withTransaction } from '../../db/tx.js';

const BACKOFF_MINUTES = [1, 5, 25];
const MAX_ATTEMPTS = 3;
const LOWER_URGENCY = { Low: 'low', Medium: 'medium', High: 'high' };

/**
 * Tick step for the async summary lifecycle (architecture doc §9).
 *
 * Claims pending rows whose next_attempt_at is due (SKIP LOCKED), asks the
 * injected generator (single attempt, never throws , see generate.js), then:
 *   - ok      → fill content, status='ready', source='llm'
 *   - fail    → attempts++ with escalating backoff
 *   - strike3 → deterministic fallback written permanently, status='ready'
 * Booking/notes flows only INSERT pending rows; this is the sole 'ready' writer.
 * With a pool, each pass claims and writes inside one transaction so SKIP
 * LOCKED claims hold until commit , otherwise overlapping ticks could both
 * process the same pending row.
 */
export async function regeneratePendingSummaries({ query, now, generatePre, generatePost, pool = null }) {
  const nowDate = now();
  let attempted = 0;

  attempted += await runPass(
    query,
    {
      sql: `SELECT pvs.appointment_id, pvs.attempts, a.symptoms_text
            FROM pre_visit_summaries pvs
            JOIN appointments a ON a.id = pvs.appointment_id
            WHERE pvs.generation_status = 'pending'
              AND (pvs.next_attempt_at IS NULL OR pvs.next_attempt_at <= $1)
            ORDER BY pvs.appointment_id
            LIMIT 20
            FOR UPDATE OF pvs SKIP LOCKED`,
      table: 'pre_visit_summaries',
      generate: generatePre,
      applySuccess: (q, id, content, model) =>
        q(
          `UPDATE pre_visit_summaries
           SET urgency=$2, chief_complaint=$3, questions=$4::jsonb,
               generation_status='ready', source='llm', model=$5,
               attempts=attempts+1, next_attempt_at=NULL
           WHERE appointment_id=$1`,
          [id, content.urgency, content.chiefComplaint, JSON.stringify(content.questions), model],
        ),
      applyFallback: (q, id, content) =>
        q(
          `UPDATE pre_visit_summaries
           SET urgency=$2, chief_complaint=$3, questions=$4::jsonb,
               generation_status='ready', source='fallback', model=NULL,
               attempts=attempts+1, next_attempt_at=NULL
           WHERE appointment_id=$1`,
          [id, content.urgency, content.chiefComplaint, JSON.stringify(content.questions)],
        ),
      fallbackFrom: (row) => {
        const c = fallbackPreVisit(row.symptoms_text);
        return { ...c, urgency: LOWER_URGENCY[c.urgency] ?? c.urgency };
      },
    },
    nowDate,
    pool,
  );

  attempted += await runPass(
    query,
    {
      sql: `SELECT pvs.appointment_id, pvs.attempts, vn.clinical_notes, vn.prescription
            FROM post_visit_summaries pvs
            JOIN visit_notes vn ON vn.appointment_id = pvs.appointment_id
            WHERE pvs.generation_status = 'pending'
              AND (pvs.next_attempt_at IS NULL OR pvs.next_attempt_at <= $1)
            ORDER BY pvs.appointment_id
            LIMIT 20
            FOR UPDATE OF pvs SKIP LOCKED`,
      table: 'post_visit_summaries',
      generate: generatePost,
      applySuccess: (q, id, content, model) =>
        q(
          `UPDATE post_visit_summaries
           SET summary_md=$2, medication_schedule=$3::jsonb, follow_up=$4,
               generation_status='ready', source='llm', model=$5,
               attempts=attempts+1, next_attempt_at=NULL
           WHERE appointment_id=$1`,
          [id, content.summaryMd, JSON.stringify(content.medicationSchedule), content.followUp, model],
        ),
      applyFallback: (q, id, content) =>
        q(
          `UPDATE post_visit_summaries
           SET summary_md=$2, medication_schedule=$3::jsonb, follow_up=$4,
               generation_status='ready', source='fallback', model=NULL,
               attempts=attempts+1, next_attempt_at=NULL
           WHERE appointment_id=$1`,
          [id, content.summaryMd, JSON.stringify(content.medicationSchedule), content.followUp],
        ),
      fallbackFrom: (row) => fallbackPostVisit(row.clinical_notes ?? '', row.prescription ?? []),
    },
    nowDate,
    pool,
  );

  return { attempted };
}

async function runPass(query, spec, nowDate, pool = null) {
  const exec = async (q) => {
    const { rows } = await q(spec.sql, [nowDate]);

    let attempted = 0;
    for (const row of rows) {
      attempted += 1;

      let outcome;
      try {
        outcome = await spec.generate(row);
      } catch {
        outcome = { ok: false };
      }

      if (outcome.ok) {
        await spec.applySuccess(q, row.appointment_id, outcome.payload, outcome.model ?? null);
        continue;
      }

      // The adapter already produced deterministic fallback content , write it
      // now instead of burning retry attempts on a decided outcome.
      if (outcome.fallbackNow) {
        await spec.applyFallback(q, row.appointment_id, outcome.fallbackNow);
        continue;
      }

      const nextAttempts = Number(row.attempts) + 1;
      if (nextAttempts >= MAX_ATTEMPTS) {
        await spec.applyFallback(q, row.appointment_id, spec.fallbackFrom(row));
        continue;
      }

      const waitMin = BACKOFF_MINUTES[Math.min(nextAttempts - 1, BACKOFF_MINUTES.length - 1)];
      await q(
        `UPDATE ${spec.table}
         SET attempts = $2, next_attempt_at = $3
         WHERE appointment_id = $1`,
        [row.appointment_id, nextAttempts, new Date(nowDate.getTime() + waitMin * 60_000)],
      );
    }
    return attempted;
  };

  return pool ? withTransaction(pool, exec) : exec(query);
}
