/**
 * Operational health for the admin console (architecture doc §11): queue
 * depths, dead-letters, and the last tick time. Read-only; no patient data.
 */
export async function healthSnapshot(query) {
  const one = async (sql) => {
    const { rows } = await query(sql);
    return Number(rows[0]?.n ?? 0);
  };

  const [emailsPending, emailsFailed, calPending, calFailed, holdsActive, summariesPending] =
    await Promise.all([
      one(`SELECT count(*)::int AS n FROM email_queue WHERE status = 'pending'`),
      one(`SELECT count(*)::int AS n FROM email_queue WHERE status = 'failed'`),
      one(`SELECT count(*)::int AS n FROM calendar_events
           WHERE sync_status IN ('pending', 'deleting')`),
      one(`SELECT count(*)::int AS n FROM calendar_events WHERE sync_status = 'failed'`),
      one(`SELECT count(*)::int AS n FROM appointments WHERE status = 'held'`),
      one(`SELECT (
             (SELECT count(*)::int FROM pre_visit_summaries WHERE generation_status = 'pending') +
             (SELECT count(*)::int FROM post_visit_summaries WHERE generation_status = 'pending')
           ) AS n`),
    ]);

  const { rows: tickRows } = await query(
    `SELECT last_run_at FROM job_state WHERE name = 'tick'`,
  );

  return {
    emails: { pending: emailsPending, failed: emailsFailed },
    calendar: { pending: calPending, failed: calFailed },
    holds: { active: holdsActive },
    summaries: { pending: summariesPending },
    lastTickAt: tickRows[0]?.last_run_at ?? null,
  };
}
