import { enqueueEmail, EMAIL_TEMPLATES } from '../emailQueue.js';
import { dateToDateStr } from '../../lib/time.js';

const LOOKAHEAD_HOURS = 24;

/**
 * Generates medication reminder emails from structured prescriptions while a
 * prescription is active: every dose moment (visit date + each day up to the
 * duration) that falls inside the lookahead window becomes one queued email,
 * deduped by `med:<appointmentId>:<date>:<time>` so repeated ticks are no-ops.
 */
export async function scheduleMedicationReminders({ query, now }) {
  const nowDate = now();
  const horizon = new Date(nowDate.getTime() + LOOKAHEAD_HOURS * 3_600_000);

  const { rows } = await query(
    `SELECT vn.appointment_id, vn.prescription, a.scheduled_at,
            u.email AS patient_email, du.name AS doctor_name
     FROM visit_notes vn
     JOIN appointments a ON a.id = vn.appointment_id
     JOIN users u ON u.id = a.patient_id
     JOIN users du ON du.id = a.doctor_id
     WHERE a.status = 'completed'`,
  );

  let scheduled = 0;

  for (const row of rows) {
    const visit = new Date(row.scheduled_at);
    const meds = Array.isArray(row.prescription) ? row.prescription : [];

    for (const med of meds) {
      const days = Number(med.durationDays);
      const times = Array.isArray(med.times) ? med.times : [];
      if (!Number.isFinite(days) || times.length === 0) continue;

      for (let dayOffset = 0; dayOffset < days; dayOffset += 1) {
        for (const hhmm of times) {
          if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(String(hhmm))) continue;
          const doseDate = new Date(visit);
          doseDate.setDate(doseDate.getDate() + dayOffset);
          const [h, m] = String(hhmm).split(':').map(Number);
          doseDate.setHours(h, m, 0, 0);

          if (doseDate <= nowDate || doseDate > horizon) continue;

          await enqueueEmail(query, {
            to: row.patient_email,
            template: EMAIL_TEMPLATES.MEDICATION_REMINDER,
            payload: {
              appointmentId: row.appointment_id,
              medication: med.name ?? 'Medication',
              dosage: med.dosage ?? '',
              time: String(hhmm),
              doseDate: dateToDateStr(doseDate),
              doctorName: row.doctor_name,
            },
            appointmentId: row.appointment_id,
            dedupKey: `med:${row.appointment_id}:${dateToDateStr(doseDate)}:${hhmm}`,
          });
          scheduled += 1;
        }
      }
    }
  }

  return { scheduled };
}
