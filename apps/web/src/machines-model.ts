import type { Machine } from '@nook/contract';
import { formatDate } from './paths';

const DAY = 86_400_000;
const STALE_AFTER_DAYS = 30;
const groups = [
  {
    id: 'stale',
    title: 'Not used in 30 days',
    hint: 'No request from these machines for over 30 days. Revoke any you no longer use.',
  },
  {
    id: 'never',
    title: 'Never used',
    hint: 'Approved, but Nook has not received a request from them yet.',
  },
  {
    id: 'recent',
    title: 'Used in the last 30 days',
    hint: 'Made a request to Nook recently.',
  },
] as const;
type GroupId = (typeof groups)[number]['id'];
function groupOf(machine: Machine, now: number): GroupId {
  if (machine.lastUsedAt === null) return 'never';
  return now - Date.parse(machine.lastUsedAt) > STALE_AFTER_DAYS * DAY
    ? 'stale'
    : 'recent';
}
function orderTime(machine: Machine, group: GroupId) {
  if (group === 'never') return Date.parse(machine.approvedAt);
  const at = Date.parse(machine.lastUsedAt ?? machine.approvedAt);
  return group === 'stale' ? at : -at;
}
export function groupMachines(machines: readonly Machine[], now: number) {
  return groups
    .map((group) => ({
      ...group,
      machines: machines
        .filter((machine) => groupOf(machine, now) === group.id)
        .sort((a, b) => orderTime(a, group.id) - orderTime(b, group.id)),
    }))
    .filter((group) => group.machines.length > 0);
}
function ago(iso: string, now: number) {
  const minutes = Math.max(0, Math.round((now - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? '' : 's'} ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}
export function lastUsedParts(machine: Machine, now: number) {
  if (machine.lastUsedAt === null) return ['Never used'];
  const parts = [`Last used ${ago(machine.lastUsedAt, now)}`];
  if (now - Date.parse(machine.lastUsedAt) >= DAY)
    parts.push(formatDate(machine.lastUsedAt));
  return parts;
}
export function approvedText(machine: Machine, now: number) {
  return `Approved ${now - Date.parse(machine.approvedAt) < DAY ? ago(machine.approvedAt, now) : formatDate(machine.approvedAt)}`;
}
