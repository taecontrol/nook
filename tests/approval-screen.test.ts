import type { ApprovalView } from '@nook/contract';
import { expect, it } from 'vitest';
import {
  approvalScreen,
  type Choice,
  submittingLabel,
} from '../apps/web/src/approval-screen';

const pending: ApprovalView = {
  id: 'synthetic-request',
  state: 'pending',
  verified: {
    machine: { id: 'synthetic-machine', name: 'omarchy' },
    secrets: [],
  },
  claimed: {
    purpose: 'test screen states',
    executable: 'pnpm',
    workingDirectory: '/tmp',
    session: null,
    client: null,
  },
  requestedAt: '2026-11-04T10:42:00.000Z',
  expiresAt: '2026-11-04T10:52:00.000Z',
};

it('a late expired detail keeps the unsaved decision alert and its choice', () => {
  const screen = approvalScreen(
    { ...pending, state: 'expired' },
    Date.parse(pending.expiresAt),
    { unsaved: true, choice: '1h' },
  );
  expect(screen).toMatchObject({
    kind: 'expired',
    unsaved: true,
    choice: '1h',
  });
});

// The browser proves the 1 hour label; these choices take other branches.
it.each([
  ['once', 'Approving this time…'],
  ['deny', 'Denying…'],
] satisfies [Choice, string][])(
  'Submitting.choice %s alone determines the busy label',
  (choice, expected) => {
    const screen = approvalScreen(pending, Date.parse(pending.requestedAt), {
      submitting: choice,
    });
    if (screen.kind !== 'submitting')
      throw new Error('The request must be submitting');
    expect(submittingLabel(screen)).toBe(expected);
  },
);
