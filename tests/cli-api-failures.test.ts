import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { machineApi } from '../apps/cli/src/api.ts';

const paths = ['work/acme/KEY'];
const expiredAt = '2026-11-01T12:00:00.000Z';
it.each([
  {
    error: { _tag: 'SecretsForbidden', message: 'Public refusal.', paths },
    expected: { tag: 'SecretsForbidden', message: 'Public refusal.', paths },
  },
  {
    error: { _tag: 'ApprovalDenied', message: 'Denied.', paths },
    expected: { tag: 'ApprovalDenied', message: 'Denied.', paths },
  },
  {
    error: { _tag: 'Unauthorized', message: 'Unauthorized.', expiredAt },
    expected: { tag: 'Unauthorized', message: 'Unauthorized.', expiredAt },
  },
  {
    error: { _tag: 'ApprovalExpired', reason: 'changed', message: 'Expired.' },
    expected: {
      tag: 'ApprovalExpired',
      approvalReason: 'changed',
      message: 'Expired.',
    },
  },
  {
    error: {
      _tag: 'InvalidSecret',
      message: '',
      paths,
      expiredAt,
      reason: 'changed',
    },
    expected: { tag: 'InvalidSecret', message: '' },
  },
  ...['ServiceUnavailable', 'TimeoutError', 'Unavailable'].map((tag) => ({
    error: {
      _tag: tag,
      message: 'Internal diagnostic.',
      paths,
      expiredAt,
      reason: 'changed',
    },
    expected: { tag, retryable: true },
  })),
  { error: {}, expected: { tag: 'Unavailable', retryable: true } },
])(
  'API classification retains only the permitted fields for $expected.tag',
  async ({ error, expected }) => {
    const failure = await Effect.runPromise(
      machineApi('https://nook.test')(() => Effect.fail(error)).pipe(
        Effect.flip,
      ),
    );
    expect({ ...failure }).toEqual({
      message: undefined,
      paths: [],
      retryable: false,
      expiredAt: undefined,
      approvalReason: undefined,
      ...expected,
    });
  },
);
