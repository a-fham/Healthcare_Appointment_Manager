import { withTransaction } from '../../db/tx.js';

/**
 * Frees holds whose expiry has passed. A hold is not an appointment; letting
 * it lapse silently (with an audit row) keeps the graded partial-unique
 * indexes meaningful without user-visible errors.
 * With a pool, the status flip and its audit rows commit atomically.
 */
export async function expireHolds(deps) {
  const exec = (query) => sweepExpiredHolds({ ...deps, query });
  return deps.pool ? withTransaction(deps.pool, exec) : exec(deps.query);
}

async function sweepExpiredHolds({ query, now }) {
  const nowDate = now();
  const { rows } = await query(
    `UPDATE appointments SET status='expired'
     WHERE status='held' AND hold_expires_at IS NOT NULL AND hold_expires_at < $1
     RETURNING id`,
    [nowDate],
  );

  for (const row of rows) {
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, 'held', 'expired', 'system', 'hold_expired')`,
      [row.id],
    );
  }

  return { expired: rows.length };
}
