// Every timestamp the owner reads is in the browser's time zone, in one English format.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export function timeoutDelay(delay: number) {
  // Timers overflow at signed 32-bit milliseconds and fire immediately, which
  // would expire a fresh request when the browser clock is far behind. Stay
  // below that limit.
  return Math.min(2 ** 31 - 2, Math.max(0, delay));
}

const dateFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});
const dateTimeFormat = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});
const clockFormat = new Intl.DateTimeFormat('en-GB', {
  hour: '2-digit',
  minute: '2-digit',
});

export function formatTime(at: string | number) {
  return clockFormat.format(new Date(at));
}

function count(amount: number, unit: string) {
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

export function formatDate(iso: string) {
  return dateFormat.format(new Date(iso));
}

export function formatDateTime(iso: string) {
  return dateTimeFormat.format(new Date(iso));
}

export function timeAgo(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / MINUTE));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${count(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${count(hours, 'hour')} ago`;
  return `${count(Math.floor(hours / 24), 'day')} ago`;
}

export function recentTime(iso: string, now = Date.now()) {
  return now - Date.parse(iso) < DAY ? timeAgo(iso, now) : formatDate(iso);
}

export function timeUntil(iso: string, now = Date.now()) {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / MINUTE));
  return `in ${count(minutes, 'minute')}`;
}

export function untilText(iso: string, now: number) {
  const remaining = Date.parse(iso) - now;
  const minutes = Math.max(1, Math.ceil(remaining / MINUTE));
  if (minutes < HOUR / MINUTE) return `in ${count(minutes, 'minute')}`;
  if (remaining < DAY)
    return `in ${count(Math.ceil(minutes / (HOUR / MINUTE)), 'hour')}`;
  return `in ${count(Math.ceil(minutes / (DAY / MINUTE)), 'day')}`;
}
