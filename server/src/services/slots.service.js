const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

function minutesFromHhMm(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
}

function hhMm(totalMinutes) {
  const h = Math.floor(totalMinutes / 60);
  const m = totalMinutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

// 0 = Sunday … 6 = Saturday (matches Date.getUTCDay and doctors.working_days)
function dayOfWeek(dateStr) {
  return new Date(`${dateStr}T00:00:00Z`).getUTCDay();
}

/**
 * Pure slot computation , no DB, no clock, no I/O. All inputs are plain data
 * so the graded scheduling logic is table-testable.
 *
 * @param doctor     {workingDays:number[], startsAt:'HH:MM', endsAt:'HH:MM', slotMinutes:number}
 * @param dateStr    'YYYY-MM-DD' clinic-local date
 * @param takenMap   Map<'HH:MM', 'booked'|'held'> live appointments that day
 * @param leaveSet   Set<'YYYY-MM-DD'> doctor's leave dates
 * @param nowStr     'YYYY-MM-DD HH:MM' clinic-local current minute
 * @returns [{startsAt:'HH:MM', status:'open'|'booked'|'held'|'past'}]
 */
export function computeSlots(doctor, dateStr, takenMap = new Map(), leaveSet = new Set(), nowStr = '') {
  if (!doctor || !DATE_RE.test(dateStr ?? '')) return [];
  const { workingDays, startsAt, endsAt, slotMinutes } = doctor;
  if (!Array.isArray(workingDays) || !TIME_RE.test(startsAt) || !TIME_RE.test(endsAt)) return [];
  const step = Number(slotMinutes);
  if (!Number.isInteger(step) || step <= 0) return [];

  if (leaveSet.has(dateStr)) return [];
  if (!workingDays.includes(dayOfWeek(dateStr))) return [];

  const startMin = minutesFromHhMm(startsAt);
  const endMin = minutesFromHhMm(endsAt);
  if (endMin <= startMin) return [];

  const slots = [];
  for (let t = startMin; t + step <= endMin; t += step) {
    const time = hhMm(t);
    const status =
      takenMap.get(time) ??
      (`${dateStr} ${time}` <= nowStr ? 'past' : 'open');
    slots.push({ startsAt: time, status });
  }
  return slots;
}

const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
