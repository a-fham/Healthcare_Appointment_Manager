import { validationError } from '../lib/errors.js';
import { isValidDateStr } from './leave.service.js';
import { dateToStamp } from '../lib/time.js';

/**
 * Doctor's day queue: confirmed + completed bookings sorted by triage urgency
 * then time. Pre-visit summary rides along (with its generation status so the
 * UI can show "preparing…" while the AI lifecycle works). Clinical shorthand
 * stays here , patients have their own view.
 */
export async function doctorQueue(query, { doctorId, date }) {
  if (date !== undefined && !isValidDateStr(date)) {
    throw validationError({ date: 'must be YYYY-MM-DD' });
  }

  const params = [doctorId];
  let where = `a.doctor_id = $1 AND a.status IN ('confirmed', 'completed')`;
  if (date !== undefined) {
    where += ` AND a.scheduled_at >= $2::date AND a.scheduled_at < ($2::date + INTERVAL '1 day')`;
    params.push(date);
  }

  const { rows } = await query(
    `SELECT a.id, a.scheduled_at, a.status, a.severity, a.symptoms_text AS symptoms,
            u.name AS patient_name,
            pvs.urgency, pvs.chief_complaint, pvs.questions, pvs.generation_status
     FROM appointments a
     JOIN users u ON u.id = a.patient_id
     LEFT JOIN pre_visit_summaries pvs ON pvs.appointment_id = a.id
     WHERE ${where}
     ORDER BY CASE COALESCE(pvs.urgency, 'low')
                WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END,
              a.scheduled_at ASC`,
    params,
  );

  return {
    date: date ?? null,
    queue: rows.map((r) => ({
      id: r.id,
      scheduledAt: dateToStamp(r.scheduled_at),
      status: r.status,
      severity: r.severity,
      patientName: r.patient_name,
      symptoms: r.symptoms ?? null,
      urgency: r.urgency ?? null,
      chiefComplaint: r.chief_complaint ?? null,
      questions: r.questions ?? [],
      generationStatus: r.generation_status ?? null,
    })),
  };
}

/**
 * Patient's own appointments, newest first. Exposes ONLY patient-safe fields:
 * status, doctor identity, and the post-visit summary once it is ready.
 * Urgency, questions, symptoms text, and clinical notes are never selected.
 */
export async function myAppointments(query, { patientId }) {
  const { rows } = await query(
    `SELECT a.id, a.scheduled_at, a.status,
            du.name AS doctor_name, d.specialisation,
            post.summary_md, post.follow_up, post.medication_schedule, post.generation_status
     FROM appointments a
     JOIN users du ON du.id = a.doctor_id
     JOIN doctors d ON d.user_id = a.doctor_id
     LEFT JOIN post_visit_summaries post ON post.appointment_id = a.id
     WHERE a.patient_id = $1
     ORDER BY a.scheduled_at DESC`,
    [patientId],
  );

  return {
    appointments: rows.map((r) => ({
      id: r.id,
      scheduledAt: dateToStamp(r.scheduled_at),
      status: r.status,
      doctorName: r.doctor_name,
      specialisation: r.specialisation,
      postVisit:
        r.generation_status === 'ready'
          ? {
              summaryMd: r.summary_md,
              medicationSchedule: r.medication_schedule ?? [],
              followUp: r.follow_up ?? '',
            }
          : null,
    })),
  };
}
