import { expect, it } from 'vitest';
import { decisionOutcome } from '../apps/worker/src/approval-decision.ts';
import type { StoredRequest } from '../apps/worker/src/approval-rows.ts';

// The Worker proves each window and a repeat after it; only the exact
// boundary needs a fixed clock.
const remember = '1h';
const window = 3_600_000;
it.each([-1, 0])(
  'E22: repeating an approval at valid_until %i ms obeys the approval window',
  (offset) => {
    const decidedAt = Date.parse('2026-11-02T12:00:00Z');
    const validUntil = decidedAt + window;
    const row: StoredRequest = {
      id: 'synthetic-request',
      machine_id: 'synthetic-machine',
      machine_name: 'synthetic',
      attempt_id: 'synthetic-attempt',
      agent: null,
      agent_session: null,
      agent_thread: null,
      secrets_json: [{ path: 'work/acme/KEY', coveredBy: null }],
      covered_json: ['work/acme/KEY'],
      purpose: 'synthetic use',
      working_directory: '/synthetic',
      executable: 'synthetic',
      client: null,
      requested_at: decidedAt - 1_000,
      expires_at: decidedAt + 599_000,
      status: 'approved',
      remember,
      decided_at: decidedAt,
      valid_until: validUntil,
    };
    const choice = { kind: 'approve', remember } as const;
    const outcome = decisionOutcome(choice, false, row, validUntil + offset);
    if (offset < 0) expect(outcome.kind).toBe('ok');
    else
      expect(outcome).toMatchObject({
        kind: 'fail',
        error: { _tag: 'AlreadyHandled', status: 'approved', remember },
      });
  },
);
