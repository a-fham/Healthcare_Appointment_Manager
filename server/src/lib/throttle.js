const WINDOW_MS = 15 * 60 * 1000;
const MAX_FAILURES = 5;

const attempts = new Map();

function key(email, ip) {
  return `${String(email).toLowerCase()}|${ip}`;
}

export function isThrottled(email, ip, now = Date.now()) {
  const entry = attempts.get(key(email, ip));
  if (!entry) return null;
  if (now >= entry.resetAt) {
    attempts.delete(key(email, ip));
    return null;
  }
  if (entry.count >= MAX_FAILURES) {
    return { retryAfterMs: entry.resetAt - now };
  }
  return null;
}

export function recordFailure(email, ip, now = Date.now()) {
  const k = key(email, ip);
  const entry = attempts.get(k);
  if (!entry || now >= entry.resetAt) {
    attempts.set(k, { count: 1, resetAt: now + WINDOW_MS });
    return;
  }
  entry.count += 1;
}

export function recordSuccess(email, ip) {
  attempts.delete(key(email, ip));
}
