import type { Provenance } from '@nook/contract';

export function principalName(memory: { provenance: Provenance }) {
  return memory.provenance.principal.kind === 'owner'
    ? 'Owner'
    : memory.provenance.principal.name;
}
export function relativeTime(value: string) {
  const hours = Math.max(
    1,
    Math.floor((Date.now() - Date.parse(value)) / 3_600_000),
  );
  return hours < 24 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}
export const absoluteTime = (value: string) =>
  `${new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'UTC' }).format(new Date(value))} UTC`;
