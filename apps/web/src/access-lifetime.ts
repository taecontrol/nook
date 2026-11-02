import { type AccessLifetime, accessLifetimeMs } from '@nook/contract';

export const lifetimeOptions: readonly {
  value: AccessLifetime;
  label: string;
}[] = [
  { value: '1d', label: '1 day' },
  { value: '7d', label: '7 days' },
  { value: '30d', label: '30 days' },
  { value: '90d', label: '90 days' },
  { value: 'never', label: 'No expiration' },
];
export const defaultLifetime: AccessLifetime = '30d';
export function lifetimeExpiry(lifetime: AccessLifetime, now: number) {
  const duration = accessLifetimeMs[lifetime];
  return duration === null ? null : new Date(now + duration).toISOString();
}
