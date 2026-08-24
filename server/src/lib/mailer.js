import nodemailer from 'nodemailer';

/**
 * Email transport adapter. The outbox pattern (architecture doc §7) means this
 * module never runs inside a request , only the tick worker calls it. When SMTP
 * is unconfigured the transport logs instead, so local/dev ticks stay green.
 */
export function makeSendEmail(config) {
  const host = config?.smtp?.host;
  if (!host) {
    return async (mail) => {
      console.log(JSON.stringify({ level: 'info', kind: 'email_dev_log', to: mail.to, template: mail.template }));
    };
  }

  const transporter = nodemailer.createTransport({
    host,
    port: Number(config.smtp.port ?? 587),
    secure: Number(config.smtp.port ?? 587) === 465,
    auth: config.smtp.user
      ? { user: config.smtp.user, pass: config.smtp.pass }
      : undefined,
  });

  return async (mail) => {
    await transporter.sendMail({
      from: config.emailFrom ?? 'clinic@example.com',
      to: mail.to,
      subject: subjectFor(mail),
      text: renderText(mail),
    });
  };
}

function subjectFor(mail) {
  switch (mail.template) {
    case 'booking_confirmation': return 'Your appointment is confirmed';
    case 'cancellation': return 'Your appointment was cancelled';
    case 'leave_cancellation': return 'Appointment cancelled, clinic schedule change';
    case 'reschedule_notice': return 'Your appointment was rescheduled';
    case 'medication_reminder': return 'Medication reminder';
    default: return 'Message from your clinic';
  }
}

function renderText(mail) {
  const p = mail.payload ?? {};
  switch (mail.template) {
    case 'booking_confirmation':
      return `Hello,\n\nYour appointment is confirmed for ${p.when ?? p.scheduledAt ?? ''} with ${p.doctorName ?? 'your doctor'}.\n\nAshgrove Family Practice`;
    case 'cancellation':
      return `Hello,\n\nYour appointment on ${p.when ?? p.scheduledAt ?? ''} has been cancelled at your request.\n\nAshgrove Family Practice`;
    case 'leave_cancellation':
      return `Hello,\n\nWe are sorry. Your appointment on ${p.scheduledAt ?? ''} had to be cancelled because the doctor is unavailable that day. Please book a new time.\n\nAshgrove Family Practice`;
    case 'reschedule_notice':
      return `Hello,\n\nYour appointment has been moved to ${p.to ?? ''}.\n\nAshgrove Family Practice`;
    case 'medication_reminder':
      return `Hello,\n\nReminder: take ${p.medication ?? 'your medication'}${p.dosage ? ` (${p.dosage})` : ''} at ${p.time ?? ''} today.\n\nAshgrove Family Practice`;
    default:
      return JSON.stringify(p);
  }
}
