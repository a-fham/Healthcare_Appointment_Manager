const p2 = (n) => String(n).padStart(2, '0');

export function dateToDateStr(date) {
  return `${date.getFullYear()}-${p2(date.getMonth() + 1)}-${p2(date.getDate())}`;
}

export function dateToTimeStr(date) {
  return `${p2(date.getHours())}:${p2(date.getMinutes())}`;
}

export function dateToStamp(date) {
  return `${dateToDateStr(date)} ${dateToTimeStr(date)}`;
}
