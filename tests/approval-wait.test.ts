import { Deferred, Effect, Fiber, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import {
  ApprovalStopped,
  awaitApproval,
  requestValues,
} from '../apps/cli/src/approval-wait.ts';
import { RequestFailure, ServerFailure } from '../apps/cli/src/errors.ts';

const first = {
  id: 'synthetic-request',
  url: 'https://nook.test/approvals/synthetic-request',
  paths: ['work/acme/KEY'],
  expiresAt: '2026-11-02T12:10:00Z',
  expiresIn: 600,
  interval: 2,
};
function failure(retryable: boolean, tag = 'Unavailable') {
  return new RequestFailure(
    'Could not reach synthetic.',
    new ServerFailure(tag, undefined, [], retryable),
  );
}
it('E9/E11: a server unreachable throughout the wait ends at the ten-minute deadline and paces stderr', async () => {
  const lines: string[] = [];
  let calls = 0;
  let code = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.scoped(
        awaitApproval(first, {
          ask: Effect.suspend(() => {
            calls++;
            return Effect.fail(failure(true));
          }),
          withdraw: () => Effect.void,
          status: (line) => lines.push(line),
          signal: Effect.never,
        }),
      ).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            code = e instanceof ApprovalStopped ? e.code : 1;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust('599 seconds');
      expect(code).toBe(0);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(code).toBe(75);
  expect(calls).toBeGreaterThan(1);
  expect(calls).toBeLessThanOrEqual(300);
  expect(lines.length).toBeLessThanOrEqual(21);
  expect(lines[0]).toContain('10:00 left');
});
// The real CLI proves each signal's exit code; these rows pair each signal
// with one race against the three-second withdrawal bound.
it.each([
  ['SIGINT', 130, 'delivery'],
  ['SIGTERM', 143, 'deadline'],
] as const)(
  'E10: %s exits %i when %s becomes ready during a stalled withdrawal, without starting a command',
  async (signalName, expectedCode, ready) => {
    let withdrawn = '';
    let code = 0;
    let commandStarted = false;
    await Effect.runPromise(
      Effect.gen(function* () {
        const signal = yield* Deferred.make<'SIGINT' | 'SIGTERM'>();
        const response = yield* Deferred.make<{
          values: { path: string; value: Redacted.Redacted<string> }[];
        }>();
        const polling = yield* Deferred.make<void>();
        const withdrawing = yield* Deferred.make<void>();
        const fiber = yield* Effect.scoped(
          awaitApproval(
            { ...first, expiresIn: ready === 'deadline' ? 4 : 600 },
            {
              ask: Deferred.succeed(polling, undefined).pipe(
                Effect.andThen(Deferred.await(response)),
              ),
              withdraw: (id) =>
                Effect.gen(function* () {
                  withdrawn = id;
                  yield* Deferred.succeed(withdrawing, undefined);
                  yield* Effect.never;
                }),
              status: () => {},
              signal: Deferred.await(signal),
            },
          ),
        ).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              commandStarted = true;
            }),
          ),
          Effect.catch((error) =>
            Effect.sync(() => {
              code = error instanceof ApprovalStopped ? error.code : 1;
            }),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust('2 seconds');
        yield* Deferred.await(polling);
        yield* Deferred.succeed(signal, signalName);
        yield* Deferred.await(withdrawing);
        if (ready === 'delivery')
          yield* Deferred.succeed(response, {
            values: [
              { path: first.paths[0], value: Redacted.make('synthetic-only') },
            ],
          });
        yield* TestClock.adjust('2 seconds');
        expect(commandStarted).toBe(false);
        expect(code).toBe(0);
        yield* TestClock.adjust('1 second');
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(withdrawn).toBe(first.id);
    expect(commandStarted).toBe(false);
    expect(code).toBe(expectedCode);
  },
);
it('E11: terminal errors during the wait are not retried', async () => {
  let calls = 0;
  let message = '';
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.scoped(
        awaitApproval(first, {
          ask: Effect.suspend(() => {
            calls++;
            return Effect.fail(failure(false, 'SecretsForbidden'));
          }),
          withdraw: () => Effect.void,
          status: () => {},
          signal: Effect.never,
        }),
      ).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            message = e.message;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(calls).toBe(1);
  expect(message).toBe('Could not reach synthetic.');
});
it.each([
  { first: 600, later: [0], end: 2 },
  { first: 600, later: [1], end: 3 },
  // A transient failure is retried, and a longer answer cannot extend the wait.
  { first: 6, later: [null, 600], end: 6 },
  // A shortened deadline must also cap an in-flight poll, not just sleeps.
  { first: 600, later: [3, 'stall' as const], end: 5 },
])(
  'E9/E11: pending answers $later after $first s end the wait at $end s',
  async ({ first: expiresIn, later, end }) => {
    let calls = 0;
    let code = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.scoped(
          awaitApproval(
            { ...first, expiresIn },
            {
              ask: Effect.suspend(() => {
                const next = later[Math.min(calls++, later.length - 1)];
                if (next === 'stall') return Effect.never;
                return next === null
                  ? Effect.fail(failure(true))
                  : Effect.succeed({
                      approval: { ...first, expiresIn: next },
                    });
              }),
              withdraw: () => Effect.void,
              status: () => {},
              signal: Effect.never,
            },
          ),
        ).pipe(
          Effect.catch((e) =>
            Effect.sync(() => {
              code = e instanceof ApprovalStopped ? e.code : 1;
            }),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust(end * 1000 - 1);
        expect(code, 'The wait is still open just before its end').toBe(0);
        yield* TestClock.adjust(1);
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(code).toBe(75);
  },
);
it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)(
  '%s bounds a stalled first values request to three more seconds and exits %i',
  async (signal, expectedCode) => {
    let code = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.scoped(
          requestValues({
            ask: Effect.never,
            withdraw: () => Effect.die('No request id is known'),
            status: () => {},
            signal: Effect.sleep('1 second').pipe(Effect.as(signal)),
          }),
        ).pipe(
          Effect.catch((error) =>
            Effect.sync(() => {
              code = error instanceof ApprovalStopped ? error.code : 1;
            }),
          ),
          Effect.forkChild,
        );
        yield* TestClock.adjust('3999 millis');
        expect(code).toBe(0);
        yield* TestClock.adjust('1 millis');
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(code).toBe(expectedCode);
  },
);
