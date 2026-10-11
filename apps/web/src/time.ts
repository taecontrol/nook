// Every timestamp the owner reads is in the browser's time zone, in one English format.
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

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

function count(amount: number, unit: string) {
  return `${amount} ${unit}${amount === 1 ? '' : 's'}`;
}

/** "Oct 11, 2026" */
export function formatDate(iso: string) {
  return dateFormat.format(new Date(iso));
}

/** "Oct 11, 2026, 3:04 PM" */
export function formatDateTime(iso: string) {
  return dateTimeFormat.format(new Date(iso));
}

/** "just now", "5 minutes ago", "3 hours ago", "52 days ago" */
export function timeAgo(iso: string, now = Date.now()) {
  const minutes = Math.max(0, Math.floor((now - Date.parse(iso)) / MINUTE));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${count(minutes, 'minute')} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${count(hours, 'hour')} ago`;
  return `${count(Math.floor(hours / 24), 'day')} ago`;
}

/** Relative within a day, then the date. */
export function recentTime(iso: string, now = Date.now()) {
  return now - Date.parse(iso) < DAY ? timeAgo(iso, now) : formatDate(iso);
}

/** "in 5 minutes", never less than a minute. */
export function timeUntil(iso: string, now = Date.now()) {
  const minutes = Math.max(1, Math.ceil((Date.parse(iso) - now) / MINUTE));
  return `in ${count(minutes, 'minute')}`;
}
