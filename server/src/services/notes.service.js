import { z } from 'zod';
import { AppError, validationError } from '../lib/errors.js';
import { withTransaction } from '../db/tx.js';

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

const prescriptionSchema = z
  .array(
    z.object({
      name: z.string().trim().min(1).max(120),
      dosage: z.string().trim().max(60).optional().default(''),
      times: z.array(z.string().regex(TIME_RE)).min(1).max(6),
      durationDays: z.number().int().min(1).max(365),
    }),
  )
  .max(20);

const recordNotesSchema = z.object({
  clinicalNotes: z.string().trim().min(1).max(10000),
  prescription: prescriptionSchema.optional().default([]),
});

/**
 * Doctor records visit outcome after seeing the patient. One transaction:
 * notes + structured prescription land, the appointment closes as completed,
 * a pending post-visit summary row is created for the async AI lifecycle,
 * and the audit trail gets its event. First write wins.
 */
export async function recordVisitNotes(pool, { appointmentId, doctorId, body }) {
  const parsed = recordNotesSchema.safeParse(body ?? {});
  if (!parsed.success) {
    const fields = Object.keys(parsed.error.flatten().fieldErrors);
    throw validationError(`Invalid fields: ${fields.join(', ')}`);
  }
  const { clinicalNotes, prescription } = parsed.data;

  return withTransaction(pool, async (query) => {
    const locked = await query(
      `SELECT id, status FROM appointments WHERE id = $1 AND doctor_id = $2 FOR UPDATE`,
      [appointmentId, doctorId],
    );
    if (locked.rows.length === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    }
    if (locked.rows[0].status !== 'confirmed') {
      throw new AppError(
        409,
        'CONFLICT',
        'Only confirmed appointments can be closed with visit notes.',
      );
    }

    const existing = await query(
      `SELECT 1 FROM visit_notes WHERE appointment_id = $1`,
      [appointmentId],
    );
    if (existing.rows.length > 0) {
      throw new AppError(409, 'CONFLICT', 'Visit already recorded for this appointment.');
    }

    await query(
      `INSERT INTO visit_notes (appointment_id, clinical_notes, prescription)
       VALUES ($1, $2, $3::jsonb)`,
      [appointmentId, clinicalNotes, JSON.stringify(prescription)],
    );
    await query(`UPDATE appointments SET status = 'completed' WHERE id = $1`, [appointmentId]);
    await query(
      `INSERT INTO post_visit_summaries (appointment_id) VALUES ($1)
       ON CONFLICT (appointment_id) DO NOTHING`,
      [appointmentId],
    );
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, 'confirmed', 'completed', 'doctor', 'visit_recorded')`,
      [appointmentId],
    );

    return { ok: true };
  });
}
