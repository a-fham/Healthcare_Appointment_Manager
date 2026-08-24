import { withTransaction } from '../../db/tx.js';

const BACKOFF_MINUTES = [1, 5, 25];
const MAX_ATTEMPTS = 3;

function nextBackoff(attemptsAfterFailure) {
  const i = Math.min(attemptsAfterFailure - 1, BACKOFF_MINUTES.length - 1);
  return BACKOFF_MINUTES[i];
}

/**
 * Outbox drain (architecture doc §7). Claims due pending emails with
 * SKIP LOCKED so multiple instances never double-send, hands each to the
 * injected transport once, and walks the retry ladder:
 *   fail → attempts+1 with backoff; strike MAX_ATTEMPTS → 'failed' dead-letter.
 * When a pool is supplied the whole drain runs inside one transaction so the
 * row locks survive past the claiming SELECT , without it, overlapping ticks
 * could both claim the same row between SELECT and UPDATE.
 */
export async function processEmails(deps) {
  const exec = (query) => drainEmails({ ...deps, query });
  return deps.pool ? withTransaction(deps.pool, exec) : exec(deps.query);
}

async function drainEmails({ query, now, sendEmail, limit = 10 }) {
  const nowDate = now();
  const { rows } = await query(
    `SELECT id, to_email, template, payload, attempts, appointment_id
     FROM email_queue
     WHERE status = 'pending' AND next_attempt_at <= $1
     ORDER BY id
     LIMIT $2
     FOR UPDATE SKIP LOCKED`,
    [nowDate, limit],
  );

  let sent = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await sendEmail({
        to: row.to_email,
        template: row.template,
        payload: row.payload,
        appointmentId: row.appointment_id,
      });
    } catch (err) {
      const attempts = Number(row.attempts) + 1;
      if (attempts >= MAX_ATTEMPTS) {
        await query(
          `UPDATE email_queue SET status='failed', attempts=$2, last_error=$3 WHERE id=$1`,
          [row.id, attempts, String(err.message).slice(0, 500)],
        );
        failed += 1;
      } else {
        await query(
          `UPDATE email_queue SET attempts=$2, last_error=$3,
             next_attempt_at=$4 WHERE id=$1`,
          [row.id, attempts, String(err.message).slice(0, 500),
           new Date(nowDate.getTime() + nextBackoff(attempts) * 60_000)],
        );
      }
      continue;
    }
    await query(
      `UPDATE email_queue SET status='sent', attempts=attempts+1, sent_at=$2, last_error=NULL WHERE id=$1`,
      [row.id, nowDate],
    );
    sent += 1;
  }

  return { attempted: rows.length, sent, failed };
}
