import { z } from 'zod';
import { AppError, validationError } from '../lib/errors.js';
import { getDoctor } from './doctors.service.js';
import { computeSlots } from './slots.service.js';
import { dateToStamp } from '../lib/time.js';
import { enqueueEmail, EMAIL_TEMPLATES } from './emailQueue.js';
import { withTransaction } from '../db/tx.js';
import { makeQuery } from '../db/pool.js';

const STAMP_RE = /^(\d{4}-\d{2}-\d{2}) ([0-2]\d:[0-5]\d)$/;

const holdSchema = z.object({
  scheduledAt: z.string().trim().regex(STAMP_RE),
});

const confirmSchema = z
  .object({
    symptomsText: z.string().trim().min(1).max(2000),
    severity: z.enum(['mild', 'moderate', 'severe']),
    durationText: z.string().trim().min(1).max(120),
  });

function slotNotOpenable() {
  return new AppError(
    422,
    'SLOT_NOT_OPENABLE',
    'That time is not available for this doctor.',
  );
}

async function loadLeaveSet(query, doctorId) {
  const { rows } = await query(
    `SELECT to_char(date, 'YYYY-MM-DD') AS d FROM leave_days WHERE doctor_id = $1`,
    [doctorId],
  );
  return new Set(rows.map((r) => r.d));
}

function slotTaken() {
  return new AppError(409, 'SLOT_TAKEN', 'That slot was just taken. Pick another time.');
}

/**
 * Locks the doctor row for the rest of the transaction. Every flow that can
 * invalidate or consume this doctor's slots (hold, confirm, reschedule,
 * markLeave) takes this lock FIRST, giving all of them a shared
 * doctors → appointments lock order , so a leave day committed concurrently
 * can never slip between a hold and its confirmation.
 */
async function lockDoctorRow(query, doctorId) {
  const { rows } = await query(
    `SELECT user_id FROM doctors WHERE user_id = $1 FOR UPDATE`,
    [doctorId],
  );
  if (rows.length === 0) throw new AppError(404, 'NOT_FOUND', 'Doctor not found.');
}

async function assertNotLeaveDay(query, doctorId, dateStr) {
  const { rowCount } = await query(
    `SELECT 1 FROM leave_days WHERE doctor_id = $1 AND date = $2::date`,
    [doctorId, dateStr],
  );
  if (rowCount > 0) {
    throw new AppError(409, 'DOCTOR_ON_LEAVE', 'The doctor is on leave that day.');
  }
}

export async function createHold(pool, { patientId, doctorId, scheduledAt }, { now, holdMinutes }) {
  const parsed = holdSchema.safeParse({ scheduledAt });
  if (!parsed.success) throw validationError('scheduledAt: must be "YYYY-MM-DD HH:MM"');
  const [, dateStr, timeStr] = scheduledAt.trim().match(STAMP_RE);

  const nowDate = now();
  const stamp = `${dateStr} ${timeStr}`;
  if (stamp < dateToStamp(nowDate)) throw slotNotOpenable();

  const query = makeQuery(pool);
  const doctor = await getDoctor(query, doctorId); // 404 when unknown
  const leaveSet = await loadLeaveSet(query, doctorId);
  if (leaveSet.has(dateStr)) {
    throw new AppError(409, 'DOCTOR_ON_LEAVE', 'The doctor is on leave that day.');
  }

  // Membership check against the SAME pure function the listing uses, so what
  // patients see as open is exactly what can be held.
  const slots = computeSlots(doctor, dateStr, new Map(), leaveSet, dateToStamp(nowDate));
  const slot = slots.find((s) => s.startsAt === timeStr);
  if (!slot) throw slotNotOpenable();
  if (slot.status === 'booked' || slot.status === 'held') throw slotTaken();
  if (slot.status !== 'open') throw slotNotOpenable();

  const expiresAt = new Date(nowDate.getTime() + holdMinutes * 60_000);

  return withTransaction(pool, async (query) => {
    await lockDoctorRow(query, doctorId);
    await assertNotLeaveDay(query, doctorId, dateStr);

    const existing = await query(
      `SELECT id, hold_expires_at FROM appointments
       WHERE patient_id = $1 AND status = 'held' FOR UPDATE`,
      [patientId],
    );
    if (existing.rowCount > 0) {
      const row = existing.rows[0];
      if (new Date(row.hold_expires_at) > nowDate) {
        throw new AppError(409, 'HOLD_EXISTS', 'You already have a pending slot hold.');
      }
      await query(`UPDATE appointments SET status = 'expired' WHERE id = $1`, [row.id]);
      await query(
        `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
         VALUES ($1, 'held', 'expired', 'system', 'superseded_by_new_hold')`,
        [row.id],
      );
    }

    let created;
    try {
      created = await query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, hold_expires_at)
         VALUES ($1, $2, $3::timestamp, 'held', $4)
         RETURNING id`,
        [patientId, doctorId, stamp, expiresAt],
      );
    } catch (err) {
      if (err.constraint === 'uniq_appt_doctor_slot') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken. Pick another time.');
      }
      if (err.constraint === 'uniq_appt_patient_hold') {
        throw new AppError(409, 'HOLD_EXISTS', 'You already have a pending slot hold.');
      }
      if (err.constraint === 'uniq_appt_patient_doctor_day') {
        throw new AppError(
          409,
          'SAME_DOCTOR_SAME_DAY',
          'You already have a booking with this doctor on that day. Cancel or pick another day.',
        );
      }
      if (err.constraint === 'no_patient_time_overlap') {
        throw new AppError(
          409,
          'TIME_OVERLAP',
          'That time overlaps another booking you already have. Pick a non-overlapping slot.',
        );
      }
      throw err;
    }
    const id = created.rows[0].id;
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, NULL, 'held', 'patient', 'hold')`,
      [id],
    );
    return { id, status: 'held', scheduledAt: `${stamp}:00`, doctorId, expiresAt };
  });
}

export async function confirmBooking(
  pool,
  { appointmentId, patientId, symptomsText, severity, durationText },
  { now },
) {
  const presence = { symptomsText, severity, durationText };
  const missing = Object.entries(presence).filter(([, v]) => typeof v !== 'string' || v.trim() === '');
  if (missing.length > 0) {
    throw new AppError(
      422,
      'SYMPTOMS_REQUIRED',
      'Please describe your symptoms before confirming. Booking without them is not possible.',
    );
  }
  const parsed = confirmSchema.safeParse({ symptomsText, severity, durationText });
  if (!parsed.success) {
    throw validationError(parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  }

  const nowDate = now();

  return withTransaction(pool, async (query) => {
    const owner = await query(
      `SELECT doctor_id FROM appointments WHERE id = $1 AND patient_id = $2`,
      [appointmentId, patientId],
    );
    if (owner.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    }
    await lockDoctorRow(query, owner.rows[0].doctor_id);

    const locked = await query(
      `SELECT a.id, a.doctor_id, a.status, a.hold_expires_at,
              to_char(a.scheduled_at, 'YYYY-MM-DD') AS appt_day,
              to_char(a.scheduled_at, 'YYYY-MM-DD HH24:MI:SS') AS sched,
              p.name AS patient_name, p.email AS patient_email,
              du.name AS doctor_name, du.email AS doctor_email
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       JOIN doctors d ON d.user_id = a.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE a.id = $1 AND a.patient_id = $2
       FOR UPDATE OF a`,
      [appointmentId, patientId],
    );
    if (locked.rowCount === 0) {
      throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    }
    const appt = locked.rows[0];
    // The hold was validated against leave_days at creation time; the admin may
    // have marked leave since. Re-check under the doctor lock so a confirmed
    // appointment can never come to rest on a leave day.
    await assertNotLeaveDay(query, appt.doctor_id, appt.appt_day);
    if (appt.status === 'confirmed') {
      throw new AppError(409, 'CONFLICT', 'This appointment is already confirmed.');
    }
    if (appt.status !== 'held') {
      throw new AppError(409, 'CONFLICT', 'This hold can no longer be confirmed.');
    }
    if (new Date(appt.hold_expires_at) <= nowDate) {
      throw new AppError(410, 'HOLD_EXPIRED', 'Your hold expired. Please pick the slot again.');
    }

    await query(
      `UPDATE appointments
       SET status = 'confirmed', symptoms_text = $2, severity = $3, duration_text = $4
       WHERE id = $1`,
      [appointmentId, parsed.data.symptomsText, parsed.data.severity, parsed.data.durationText],
    );

    await query(
      `INSERT INTO pre_visit_summaries (appointment_id, generation_status, next_attempt_at)
       VALUES ($1, 'pending', $2)`,
      [appointmentId, nowDate],
    );

    const payload = {
      patientName: appt.patient_name,
      doctorName: appt.doctor_name,
      when: appt.sched,
    };
    await enqueueEmail(query, {
      to: appt.patient_email,
      template: EMAIL_TEMPLATES.BOOKING_CONFIRMATION,
      payload,
      appointmentId,
      dedupKey: `confirm:${appointmentId}:patient`,
    });
    await enqueueEmail(query, {
      to: appt.doctor_email,
      template: EMAIL_TEMPLATES.BOOKING_CONFIRMATION,
      payload,
      appointmentId,
      dedupKey: `confirm:${appointmentId}:doctor`,
    });

    for (const audience of ['patient', 'doctor']) {
      await query(
        `INSERT INTO calendar_events (appointment_id, audience, sync_status)
         VALUES ($1, $2, 'pending')`,
        [appointmentId, audience],
      );
    }

    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, 'held', 'confirmed', 'patient', 'confirmed_with_symptoms')`,
      [appointmentId],
    );

    return {
      appointment: { id: appointmentId, status: 'confirmed', scheduledAt: appt.sched },
      summary: { generationStatus: 'pending' },
    };
  });
}

export async function cancelAppointment(pool, { appointmentId, actorId, actorRole }, { now }) {
  const isAdmin = actorRole === 'admin';
  const finalStatus = isAdmin ? 'cancelled_by_admin' : 'cancelled_by_patient';

  return withTransaction(pool, async (query) => {
    const locked = await query(
      `SELECT a.id, a.status,
              to_char(a.scheduled_at, 'YYYY-MM-DD HH24:MI:SS') AS sched,
              p.email AS patient_email, du.email AS doctor_email
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       JOIN doctors d ON d.user_id = a.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE a.id = $1 AND ($3 = 'admin' OR a.patient_id = $2)
       FOR UPDATE OF a`,
      [appointmentId, actorId, actorRole],
    );
    if (locked.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    const appt = locked.rows[0];
    if (!['confirmed', 'held'].includes(appt.status)) {
      throw new AppError(409, 'CONFLICT', 'This appointment cannot be cancelled.');
    }

    await query(`UPDATE appointments SET status = $2 WHERE id = $1`, [appointmentId, finalStatus]);
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, $2, $3, $4, 'cancellation_request')`,
      [appointmentId, appt.status, finalStatus, actorRole],
    );

    if (appt.status === 'confirmed') {
      const payload = { when: appt.sched };
      await enqueueEmail(query, {
        to: appt.patient_email,
        template: EMAIL_TEMPLATES.CANCELLATION,
        payload,
        appointmentId,
        dedupKey: `cancel:${appointmentId}:patient`,
      });
      await enqueueEmail(query, {
        to: appt.doctor_email,
        template: EMAIL_TEMPLATES.CANCELLATION,
        payload,
        appointmentId,
        dedupKey: `cancel:${appointmentId}:doctor`,
      });
      await query(
        `UPDATE calendar_events SET sync_status = 'deleting', updated_at = $2
         WHERE appointment_id = $1`,
        [appointmentId, now()],
      );
    }

    return { appointment: { id: appointmentId, status: finalStatus, scheduledAt: appt.sched } };
  });
}

export async function rescheduleAppointment(
  pool,
  { appointmentId, patientId, newScheduledAt },
  { now, holdMinutes },
) {
  const parsed = holdSchema.safeParse({ scheduledAt: newScheduledAt });
  if (!parsed.success) throw validationError('newScheduledAt: must be "YYYY-MM-DD HH:MM"');
  const [, dateStr, timeStr] = newScheduledAt.trim().match(STAMP_RE);

  const nowDate = now();
  const stamp = `${dateStr} ${timeStr}`;
  if (stamp < dateToStamp(nowDate)) throw slotNotOpenable();

  return withTransaction(pool, async (query) => {
    const owner = await query(
      `SELECT doctor_id FROM appointments WHERE id = $1 AND patient_id = $2`,
      [appointmentId, patientId],
    );
    if (owner.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    await lockDoctorRow(query, owner.rows[0].doctor_id);

    const locked = await query(
      `SELECT a.id, a.patient_id, a.doctor_id, a.status, a.symptoms_text, a.severity, a.duration_text,
              p.email AS patient_email, du.email AS doctor_email
       FROM appointments a
       JOIN users p ON p.id = a.patient_id
       JOIN doctors d ON d.user_id = a.doctor_id
       JOIN users du ON du.id = d.user_id
       WHERE a.id = $1 AND a.patient_id = $2
       FOR UPDATE OF a`,
      [appointmentId, patientId],
    );
    if (locked.rowCount === 0) throw new AppError(404, 'NOT_FOUND', 'Appointment not found.');
    const appt = locked.rows[0];
    if (appt.status !== 'confirmed') {
      throw new AppError(409, 'CONFLICT', 'Only confirmed appointments can be rescheduled.');
    }

    // Slot availability is re-derived inside the transaction (under the doctor
    // lock) so a leave day marked concurrently cannot be raced past.
    const doctor = await getDoctor(query, appt.doctor_id);
    const leaveSet = await loadLeaveSet(query, appt.doctor_id);
    await assertNotLeaveDay(query, appt.doctor_id, dateStr);

    const others = await query(
      `SELECT to_char(scheduled_at, 'HH24:MI') AS t
       FROM appointments
       WHERE doctor_id = $1 AND scheduled_at::date = $2::date
         AND status IN ('held', 'confirmed') AND id <> $3`,
      [appt.doctor_id, dateStr, appointmentId],
    );
    const takenMap = new Map(others.rows.map((r) => [r.t, 'booked']));
    const slots = computeSlots(doctor, dateStr, takenMap, leaveSet, dateToStamp(nowDate));
    const slot = slots.find((s) => s.startsAt === timeStr);
    if (!slot) throw slotNotOpenable();
    if (slot.status !== 'open') throw slotTaken();

    // Release the old appointment's slot first so the DB constraints
    // (same-doctor-same-day, time-overlap) don't fire against ourselves.
    await query(`UPDATE appointments SET status = 'rescheduled' WHERE id = $1`, [appointmentId]);
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, 'confirmed', 'rescheduled', 'patient', 'reschedule')`,
      [appointmentId],
    );

    let shadow;
    try {
      shadow = await query(
        `INSERT INTO appointments (patient_id, doctor_id, scheduled_at, status, hold_expires_at)
         VALUES ($1, $2, $3::timestamp, 'held', $4)
         RETURNING id`,
        [appt.patient_id ?? patientId, appt.doctor_id, stamp, new Date(nowDate.getTime() + holdMinutes * 60_000)],
      );
    } catch (err) {
      // withTransaction will ROLLBACK the status change + event insert.
      if (err.constraint === 'uniq_appt_doctor_slot') {
        throw new AppError(409, 'SLOT_TAKEN', 'That slot was just taken. Pick another time.');
      }
      if (err.constraint === 'uniq_appt_patient_hold') {
        throw new AppError(409, 'HOLD_EXISTS', 'You already have a pending slot hold.');
      }
      if (err.constraint === 'uniq_appt_patient_doctor_day') {
        throw new AppError(
          409,
          'SAME_DOCTOR_SAME_DAY',
          'You already have a booking with this doctor on that day. Cancel or pick another day.',
        );
      }
      if (err.constraint === 'no_patient_time_overlap') {
        throw new AppError(
          409,
          'TIME_OVERLAP',
          'That time overlaps another booking you already have. Pick a non-overlapping slot.',
        );
      }
      throw err;
    }
    const newId = shadow.rows[0].id;

    await query(
      `UPDATE appointments
       SET status = 'confirmed',
           symptoms_text = $2, severity = $3, duration_text = $4,
           hold_expires_at = NULL
       WHERE id = $1`,
      [newId, appt.symptoms_text, appt.severity, appt.duration_text],
    );
    await query(
      `INSERT INTO appointment_events (appointment_id, from_status, to_status, actor_role, reason)
       VALUES ($1, 'held', 'confirmed', 'patient', $2)`,
      [newId, `rescheduled_from:${appointmentId}`],
    );

    await query(
      `UPDATE calendar_events SET sync_status = 'deleting', updated_at = $2 WHERE appointment_id = $1`,
      [appointmentId, nowDate],
    );
    for (const audience of ['patient', 'doctor']) {
      await query(
        `INSERT INTO calendar_events (appointment_id, audience, sync_status) VALUES ($1, $2, 'pending')`,
        [newId, audience],
      );
    }

    const payload = { from: null, to: stamp };
    await enqueueEmail(query, {
      to: appt.patient_email,
      template: EMAIL_TEMPLATES.RESCHEDULE_NOTICE,
      payload,
      appointmentId,
      dedupKey: `resched:${appointmentId}:patient:${stamp}`,
    });
    await enqueueEmail(query, {
      to: appt.doctor_email,
      template: EMAIL_TEMPLATES.RESCHEDULE_NOTICE,
      payload,
      appointmentId,
      dedupKey: `resched:${appointmentId}:doctor:${stamp}`,
    });

    return {
      appointment: { id: newId, status: 'confirmed', scheduledAt: `${stamp}:00` },
      previous: { id: appointmentId, status: 'rescheduled' },
    };
  });
}
