import { withTransaction } from '../../db/tx.js';

const BACKOFF_MINUTES = [1, 5, 25];
const MAX_ATTEMPTS = 3;

/**
 * Calendar sync drain (architecture doc §7). Handles the two live work items:
 *   pending  → create the Google event for its audience, store google_event_id
 *   deleting → remove the remote event if one exists, mark deleted
 * Failures retry with the shared ladder; strike three dead-letters as 'failed'.
 * With a pool the drain runs inside one transaction so SKIP LOCKED claims hold
 * until the marking writes commit; without it the locks would evaporate at
 * statement end and overlapping ticks could double-create remote events.
 */
export async function processCalendarEvents(deps) {
  const exec = (query) => drainCalendarEvents({ ...deps, query });
  return deps.pool ? withTransaction(deps.pool, exec) : exec(deps.query);
}

async function drainCalendarEvents({ query, now, cal, limit = 10 }) {
  const nowDate = now();
  const { rows } = await query(
    `SELECT ce.id, ce.appointment_id, ce.audience, ce.google_event_id,
            ce.sync_status, ce.attempts,
            a.scheduled_at, a.symptoms_text,
            pu.name AS patient_name, du.name AS doctor_name,
            d.specialisation
     FROM calendar_events ce
     JOIN appointments a ON a.id = ce.appointment_id
     JOIN users pu ON pu.id = a.patient_id
     JOIN users du ON du.id = a.doctor_id
     JOIN doctors d ON d.user_id = a.doctor_id
     WHERE ce.sync_status IN ('pending', 'deleting')
       AND ce.next_attempt_at <= $1
     ORDER BY ce.id
     LIMIT $2
     FOR UPDATE OF ce SKIP LOCKED`,
    [nowDate, limit],
  );

  let synced = 0;
  let deleted = 0;
  let failed = 0;

  const bumpOrDeadLetter = async (row, err) => {
    const attempts = Number(row.attempts) + 1;
    if (attempts >= MAX_ATTEMPTS) {
      await query(
        `UPDATE calendar_events SET sync_status='failed', attempts=$2, last_error=$3 WHERE id=$1`,
        [row.id, attempts, String(err.message).slice(0, 500)],
      );
      failed += 1;
    } else {
      const i = Math.min(attempts - 1, BACKOFF_MINUTES.length - 1);
      await query(
        `UPDATE calendar_events SET attempts=$2, last_error=$3,
           next_attempt_at=$4, updated_at=$5 WHERE id=$1`,
        [row.id, attempts, String(err.message).slice(0, 500),
         new Date(nowDate.getTime() + BACKOFF_MINUTES[i] * 60_000), nowDate],
      );
    }
  };

  for (const row of rows) {
    try {
      if (row.sync_status === 'deleting') {
        if (row.google_event_id) {
          await cal.deleteEvent({ googleEventId: row.google_event_id, audience: row.audience });
        }
        await query(
          `UPDATE calendar_events SET sync_status='deleted', updated_at=$2 WHERE id=$1`,
          [row.id, nowDate],
        );
        deleted += 1;
        continue;
      }

      const res = await cal.createEvent({
        appointmentId: row.appointment_id,
        audience: row.audience,
        summary: row.audience === 'patient'
          ? `Clinic appointment with ${row.doctor_name} (${row.specialisation})`
          : `Consultation with ${row.patient_name}`,
        start: new Date(row.scheduled_at),
      });
      await query(
        `UPDATE calendar_events SET sync_status='synced', google_event_id=$2,
           updated_at=$3, last_error=NULL WHERE id=$1`,
        [row.id, res.googleEventId ?? null, nowDate],
      );
      synced += 1;
    } catch (err) {
      await bumpOrDeadLetter(row, err);
    }
  }

  return { attempted: rows.length, synced, deleted, failed };
}
