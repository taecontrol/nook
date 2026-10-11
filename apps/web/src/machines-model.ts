import type { Machine } from '@nook/contract';
import { DAY, formatDate, recentTime, timeAgo } from './time';

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
export function lastUsedParts(machine: Machine, now: number) {
  if (machine.lastUsedAt === null) return ['Never used'];
  const parts = [`Last used ${timeAgo(machine.lastUsedAt, now)}`];
  if (now - Date.parse(machine.lastUsedAt) >= DAY)
    parts.push(formatDate(machine.lastUsedAt));
  return parts;
}
export function approvedText(machine: Machine, now: number) {
  return `Approved ${recentTime(machine.approvedAt, now)}`;
}
