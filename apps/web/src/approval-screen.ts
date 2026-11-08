import {
  type ApprovalView,
  type ApprovalRemember as Remember,
  rememberDuration,
} from '@nook/contract';
import { approvalTimeLeft } from './approval-time';
import { formatTime } from './time';

export type Choice = Remember | 'deny';
type View<State extends ApprovalView['state']> = ApprovalView & {
  state: State;
};
export type Submitting = {
  kind: 'submitting';
  choice: Choice;
  view: View<'pending'>;
};
export type Screen =
  | { kind: 'pending'; view: View<'pending'> }
  | Submitting
  | { kind: 'approved'; view: View<'approved'> }
  | { kind: 'denied'; view: View<'denied'> }
  | { kind: 'withdrawn'; view: View<'withdrawn'> }
  | { kind: 'settled'; view: View<'settled'> }
  | {
      kind: 'expired';
      view: View<'pending' | 'expired'>;
      unsaved: boolean;
      choice?: Choice;
    };
export type Local = { submitting?: Choice; unsaved?: boolean; choice?: Choice };

function pendingScreen(
  view: View<'pending'>,
  now: number,
  local: Local,
): Screen {
  if (local.submitting)
    return { kind: 'submitting', choice: local.submitting, view };
  if (local.unsaved)
    return { kind: 'expired', unsaved: true, choice: local.choice, view };
  if (approvalTimeLeft(view, now) <= 0)
    return { kind: 'expired', unsaved: false, view };
  return { kind: 'pending', view };
}

export function approvalScreen(
  view: ApprovalView,
  now: number,
  local: Local,
): Screen {
  switch (view.state) {
    case 'pending':
      return pendingScreen({ ...view, state: view.state }, now, local);
    case 'expired':
      return {
        kind: 'expired',
        unsaved: !!local.unsaved,
        choice: local.choice,
        view: { ...view, state: view.state },
      };
    case 'approved':
      return { kind: view.state, view };
    case 'denied':
      return { kind: view.state, view };
    case 'withdrawn':
      return { kind: view.state, view: { ...view, state: view.state } };
    case 'settled':
      return { kind: view.state, view: { ...view, state: view.state } };
  }
}
export function endsAt(remember: Remember, now: number): number | null {
  if (remember === 'once') return null;
  return now + rememberDuration[remember];
}
export const durationLabel = {
  once: 'Only this time',
  '1h': '1 hour',
  '12h': '12 hours',
};
export const endTime = formatTime;
export function submittingLabel({ choice }: Submitting) {
  if (choice === 'deny') return 'Denying…';
  if (choice === 'once') return 'Approving this time…';
  return `Approving for ${durationLabel[choice]}…`;
}
export function timeLeft(ms: number) {
  const seconds = Math.ceil(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')} left`;
}
export function approvalScope(
  view: ApprovalView,
  remember: Remember,
  until: number | string | null,
): (string | { path: string })[] {
  if (remember === 'once')
    return ['Only this run gets the secrets. The next run asks again.'];
  const covered = coveredSecrets(view);
  const secrets = covered.length === 1 ? 'this secret' : 'these secrets';
  const scope: (string | { path: string })[] = [
    `Any later run on ${view.verified.machine.name} uses ${secrets}`,
  ];
  // Mixed requests still show every requested path in the verified details.
  // Name the covered subset here so "these secrets" cannot include unmarked paths.
  if (covered.length !== view.verified.secrets.length) {
    scope.push(' (');
    for (const [index, { path }] of covered.entries()) {
      if (index > 0) scope.push(', ');
      scope.push({ path });
    }
    scope.push(')');
  }
  scope.push(
    ` without asking until ${endTime(until ?? Date.now())}, whichever agent runs it. Other secrets still ask.`,
  );
  return scope;
}
export function coveredSecrets(view: ApprovalView) {
  return view.verified.secrets.filter(({ coveredBy }) => coveredBy !== null);
}
