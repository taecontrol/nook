import type { ApprovalView } from '@nook/contract';
import { expect, expectTypeOf, it } from 'vitest';
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

it('Screen narrows its view by kind, including approved metadata and submitting choice', () => {
  const approved: ApprovalView = {
    ...pending,
    state: 'approved',
    remember: '1h',
    decidedAt: pending.requestedAt,
    validUntil: '2026-11-04T11:42:00.000Z',
  };
  const screens = [
    approvalScreen(pending, Date.parse(pending.requestedAt), {}),
    approvalScreen(pending, Date.parse(pending.requestedAt), {
      submitting: '1h',
    }),
    approvalScreen(approved, Date.parse(pending.requestedAt), {}),
    approvalScreen(
      { ...pending, state: 'denied', decidedAt: pending.requestedAt },
      Date.parse(pending.requestedAt),
      {},
    ),
  ];
  expect(screens.map((screen) => screen.kind)).toEqual([
    'pending',
    'submitting',
    'approved',
    'denied',
  ]);
  for (const screen of screens) {
    if (screen.kind === 'approved') {
      expectTypeOf(screen.view).toMatchTypeOf<
        Extract<ApprovalView, { state: 'approved' }>
      >();
      expect(screen.view.remember).toBe('1h');
    }
    if (screen.kind === 'denied')
      expectTypeOf(screen.view).toMatchTypeOf<
        Extract<ApprovalView, { state: 'denied' }>
      >();
    if (screen.kind === 'pending' || screen.kind === 'submitting')
      expectTypeOf(screen.view.state).toEqualTypeOf<'pending'>();
  }
});

it.each([
  ['once', 'Approving this time…'],
  ['1h', 'Approving for 1 hour…'],
  ['12h', 'Approving for 12 hours…'],
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
