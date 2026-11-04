import type {
  ApprovalView,
  ApprovalRemember as Remember,
} from '@nook/contract';
import { formatTime } from './time';

export type Choice = Remember | 'deny';
export type Submitting = { kind: 'submitting'; choice: Choice };
export type Screen = { view: ApprovalView } & (
  | { kind: 'pending' }
  | Submitting
  | { kind: 'approved' | 'denied' | 'withdrawn' | 'settled' }
  | { kind: 'expired'; unsaved: boolean; choice?: Choice }
);

export function approvalScreen(
  view: ApprovalView,
  now: number,
  local: { submitting?: Choice; unsaved?: boolean; choice?: Choice },
): Screen {
  if (local.submitting)
    return { kind: 'submitting', choice: local.submitting, view };
  if (local.unsaved)
    return { kind: 'expired', unsaved: true, choice: local.choice, view };
  if (view.state === 'pending' && Date.parse(view.expiresAt) <= now)
    return { kind: 'expired', unsaved: false, view };
  if (view.state === 'expired')
    return { kind: 'expired', unsaved: false, view };
  return { kind: view.state, view };
}
export function endsAt(remember: Remember, now: number): number | null {
  if (remember === 'once') return null;
  return now + (remember === '1h' ? 1 : 12) * 3_600_000;
}
export const durationLabel = {
  once: 'Only this time',
  '1h': '1 hour',
  '12h': '12 hours',
};
export const endTime = formatTime;
export function timeLeft(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
}
export function approvalScope(
  view: ApprovalView,
  remember: Remember,
  until: number | string | null,
) {
  if (remember === 'once')
    return 'Only this run gets the secrets. The next run asks again.';
  const secrets =
    view.verified.secrets.length === 1 ? 'this secret' : 'these secrets';
  return `Any later run on ${view.verified.machine.name} uses ${secrets} without asking until ${endTime(until ?? Date.now())}, whichever agent runs it. Other secrets still ask.`;
}
