export const EMAIL_TEMPLATES = {
  BOOKING_CONFIRMATION: 'booking_confirmation',
  APPOINTMENT_REMINDER: 'appointment_reminder',
  MEDICATION_REMINDER: 'medication_reminder',
  CANCELLATION: 'cancellation',
  LEAVE_CANCELLATION: 'leave_cancellation',
  RESCHEDULE_NOTICE: 'reschedule_notice',
};

/**
 * Enqueue an outbound email inside the caller's transaction. Delivery happens
 * later via the tick worker (architecture doc §7) , nothing here touches SMTP.
 * dedupKey makes re-enqueues of the same logical event no-ops while the first
 * row is still alive.
 */
export async function enqueueEmail(query, { to, template, payload = {}, appointmentId = null, dedupKey = null }) {
  if (!to) throw new Error(`enqueueEmail: missing recipient for ${template}`);
  await query(
    `INSERT INTO email_queue (to_email, template, payload, appointment_id, dedup_key)
     VALUES ($1, $2, $3::jsonb, $4, $5)
     ON CONFLICT (dedup_key) WHERE dedup_key IS NOT NULL AND status <> 'failed'
     DO NOTHING`,
    [String(to).toLowerCase(), template, JSON.stringify(payload), appointmentId, dedupKey],
  );
}
