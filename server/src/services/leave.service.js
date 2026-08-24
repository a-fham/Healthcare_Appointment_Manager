import { AppError, validationError } from '../lib/errors.js';
import { withTransaction } from '../db/tx.js';
import { enqueueEmail, EMAIL_TEMPLATES } from './emailQueue.js';

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export function isValidDateStr(s) {
  if (typeof s !== 'string' || !DATE_RE.test(s)) return false;
  const d = new Date(`${s}T00:00:00`);
  return !Number.isNaN(d.getTime());
}

async function requireDoctor(query, doctorId) {
  const { rows } = await query(
    `SELECT d.user_id AS id
     FROM doctors d JOIN users u ON u.id = d.user_id
     WHERE d.user_id = $1 AND u.role = 'doctor'`,
    [doctorId],
  );
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
  return rows[0];
}

function requireDoctorForUpdate(query, doctorId) {
  return query(`SELECT user_id FROM doctors WHERE user_id = $1 FOR UPDATE`, [
    doctorId,
  ]).then(({ rows }) => {
    if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
    return rows[0];
  });
}

/**
 * How many confirmed bookings would be affected by marking leave on a date.
 * Pure read , lets admins preview before pulling the trigger (architecture §5).
 */
export async function previewLeave(query, { doctorId, date }) {
  if (!isValidDateStr(date)) throw validationError({ date: 'must be YYYY-MM-DD' });
  await requireDoctor(query, doctorId);
  const { rows } = await query(
    `SELECT count(*)::int AS n
     FROM appointments
     WHERE doctor_id = $1 AND status = 'confirmed'
       AND scheduled_at >= $2::date AND scheduled_at < ($2::date + INTERVAL '1 day')`,
    [doctorId, date],
  );
  return { date, affectedCount: rows[0].n };
}

/**
 * Mark a leave day and atomically cancel every confirmed booking on it:
 * status → cancelled_by_leave, audit rows, leave_cancellation emails for both
 * sides, calendar events flipped to 'deleting'. Idempotent: re-marking an
 * existing leave day cancels nothing new. Slots for that date vanish because
 * computeSlots consults leave_days.
 */
export async function markLeave(pool, { doctorId, date }, { actorRole = 'admin' } = {}) {
  if (!isValidDateStr(date)) throw validationError({ date: 'must be YYYY-MM-DD' });

  return withTransaction(pool, async (query) => {
    // Doctor-row lock FIRST: hold/confirm/reschedule take the same lock before
    // touching appointments, so a confirmation racing this leave either sees
    // the committed leave day (rejected) or lands before this tx starts
    // reading bookings (cascade cancels it). No window remains.
    await requireDoctorForUpdate(query, doctorId);

    await query(
      `INSERT INTO leave_days (doctor_id, date) VALUES ($1, $2::date)
       ON CONFLICT (doctor_id, date) DO NOTHING`,
      [doctorId, date],
    );

    const { rows: affected } = await query(
      `UPDATE appointments
       SET status = 'cancelled_by_leave'
       WHERE doctor_id = $1 AND status = 'confirmed'
         AND scheduled_at >= $2::date AND scheduled_at < ($2::date + INTERVAL '1 day')
       RETURNING id, patient_id, scheduled_at`,
      [doctorId, date],
    );

    for (const appt of affected) {
      await query(
        `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
         VALUES ($1, 'confirmed', 'cancelled_by_leave', $2, $3)`,
        [appt.id, actorRole, `leave:${date}`],
      );

      const people = await query(
        `SELECT p.email AS patient_email, d.email AS doctor_email
         FROM appointments a
         JOIN users p ON p.id = a.patient_id
         JOIN users d ON d.id = a.doctor_id
         WHERE a.id = $1`,
        [appt.id],
      );
      const { patient_email: pe, doctor_email: de } = people.rows[0];

      await enqueueEmail(query, {
        to: pe,
        template: EMAIL_TEMPLATES.LEAVE_CANCELLATION,
        payload: { appointmentId: appt.id, scheduledAt: appt.scheduled_at, reason: 'doctor_leave' },
        appointmentId: appt.id,
        dedupKey: `leave:${appt.id}:patient:${date}`,
      });
      await enqueueEmail(query, {
        to: de,
        template: EMAIL_TEMPLATES.LEAVE_CANCELLATION,
        payload: { appointmentId: appt.id, scheduledAt: appt.scheduled_at, reason: 'doctor_leave' },
        appointmentId: appt.id,
        dedupKey: `leave:${appt.id}:doctor:${date}`,
      });

      await query(`UPDATE calendar_events SET sync_status = 'deleting' WHERE appointment_id = $1`, [
        appt.id,
      ]);
    }

    return { date, cancelledCount: affected.length };
  });
}
