import {
  ApprovalAlreadyHandled,
  ApprovalDenied,
  ApprovalExpired,
  type ApprovalReference,
  type ApprovalView,
  Expired,
  InvalidRun,
  normalizeAgentSession,
  type ApprovalRemember as Remember,
  type RunSecrets,
} from '@nook/contract';
import { HttpApiError } from 'effect/http-api';
import type { StoredApproved, StoredRequest } from './approvals.ts';

export type OwnerChoice =
  | { kind: 'approve'; remember: Remember }
  | { kind: 'deny' };
export type AttemptPayload = Pick<
  RunSecrets,
  'secrets' | 'purpose' | 'workingDirectory' | 'executable' | 'agentSession'
>;
export type ValuesDecision =
  | { kind: 'deliver'; approval: ApprovalReference; settle: string | null }
  | { kind: 'pending'; request: Extract<StoredRequest, { status: 'pending' }> }
  | { kind: 'create' }
  | { kind: 'refuse'; error: InvalidRun | ApprovalDenied | ApprovalExpired };
export function samePayload(row: StoredRequest, input: AttemptPayload) {
  const paths = [...new Set(input.secrets)].sort();
  const claim = normalizeAgentSession(input.agentSession);
  const facts = [
    input.purpose,
    input.workingDirectory,
    input.executable,
    claim?.agent ?? null,
    claim?.session ?? null,
    claim?.thread ?? null,
  ];
  return (
    JSON.stringify(row.secrets_json.map((s) => s.path).sort()) ===
      JSON.stringify(paths) &&
    JSON.stringify([
      row.purpose,
      row.working_directory,
      row.executable,
      row.agent,
      row.agent_session,
      row.agent_thread,
    ]) === JSON.stringify(facts)
  );
}
function covers(approved: readonly string[], covered: readonly string[]) {
  return covered.every((path) => approved.includes(path));
}
export function matchRemembered(
  rows: readonly StoredApproved[],
  covered: readonly string[],
  now: number,
) {
  return rows.find(
    (row) =>
      row.status === 'approved' &&
      row.remember !== 'once' &&
      row.valid_until > now &&
      covers(row.covered_json, covered),
  );
}
export function ownTerminal(
  own: StoredRequest | undefined,
  payload: AttemptPayload,
) {
  if (!own) return;
  if (!samePayload(own, payload))
    return new InvalidRun({
      message: 'This attempt id was already used for a different run.',
    });
  if (own.status === 'denied')
    return new ApprovalDenied({ paths: own.covered_json });
}
function ownWaiting(
  own: StoredRequest,
  covered: readonly string[],
  now: number,
): ValuesDecision {
  if (own.status === 'pending' && own.expires_at > now)
    return { kind: 'pending', request: own };
  if (
    own.status === 'approved' &&
    own.valid_until > now &&
    covers(own.covered_json, covered)
  )
    return {
      kind: 'deliver',
      approval: { id: own.id, remember: own.remember },
      settle: null,
    };
  return {
    kind: 'refuse',
    error: new ApprovalExpired({
      reason: own.status === 'withdrawn' ? 'withdrawn' : 'expired',
    }),
  };
}
export function decideValues(input: {
  now: number;
  covered: readonly string[];
  payload: AttemptPayload;
  own: StoredRequest | undefined;
  remembered: readonly StoredApproved[];
}): ValuesDecision {
  const error = ownTerminal(input.own, input.payload);
  if (error) return { kind: 'refuse', error };
  const remembered = matchRemembered(
    input.remembered,
    input.covered,
    input.now,
  );
  if (remembered)
    return {
      kind: 'deliver',
      approval: { id: remembered.id, remember: remembered.remember },
      settle: input.own?.status === 'pending' ? input.own.id : null,
    };
  return input.own
    ? ownWaiting(input.own, input.covered, input.now)
    : { kind: 'create' };
}
export function decisionOutcome(
  choice: OwnerChoice,
  updated: boolean,
  row: StoredRequest | undefined,
  _now: number,
) {
  if (!row)
    return { kind: 'fail', error: new HttpApiError.NotFound() } as const;
  if (updated || sameChoice(choice, row)) return { kind: 'ok' } as const;
  if (row.status === 'pending')
    return { kind: 'fail', error: new Expired() } as const;
  return {
    kind: 'fail',
    error: new ApprovalAlreadyHandled({
      status: row.status,
      remember: row.status === 'approved' ? row.remember : null,
    }),
  } as const;
}
function sameChoice(choice: OwnerChoice, row: StoredRequest) {
  return choice.kind === 'deny'
    ? row.status === 'denied'
    : row.status === 'approved' && row.remember === choice.remember;
}
type UndecidedRequest = Exclude<
  StoredRequest,
  { status: 'approved' } | { status: 'denied' }
>;
export function viewState(
  row: UndecidedRequest,
  now: number,
): 'pending' | 'withdrawn' | 'settled' | 'expired';
export function viewState(
  row: StoredRequest,
  now: number,
): ApprovalView['state'];
export function viewState(
  row: StoredRequest,
  now: number,
): ApprovalView['state'] {
  return row.status === 'pending' && row.expires_at <= now
    ? 'expired'
    : row.status;
}
