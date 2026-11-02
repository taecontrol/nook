import { Deferred, Effect, Fiber, Redacted } from 'effect';
import { TestClock } from 'effect/testing';
import { expect, it } from 'vitest';
import {
  ApprovalStopped,
  awaitApproval,
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
it('E10: a stalled withdraw is bounded to three seconds after SIGTERM', async () => {
  let withdrawn = '';
  let code = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const signal = yield* Deferred.make<'SIGTERM'>();
      const fiber = yield* Effect.scoped(
        awaitApproval(first, {
          ask: Effect.never,
          withdraw: (id) =>
            Effect.sync(() => {
              withdrawn = id;
            }).pipe(Effect.andThen(Effect.never)),
          status: () => {},
          signal: Deferred.await(signal),
        }),
      ).pipe(
        Effect.catch((e) =>
          Effect.sync(() => {
            code = e instanceof ApprovalStopped ? e.code : 1;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust('1 second');
      yield* Deferred.succeed(signal, 'SIGTERM');
      yield* TestClock.adjust('2 seconds');
      expect(code).toBe(0);
      yield* TestClock.adjust('1 second');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(withdrawn).toBe(first.id);
  expect(code).toBe(143);
});
it.each([
  ['SIGINT', 130, 'delivery'],
  ['SIGTERM', 143, 'delivery'],
  ['SIGINT', 130, 'deadline'],
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
it('E11/E19: transient failures reuse the ask and a pending answer cannot extend the original deadline', async () => {
  let calls = 0;
  let code = 0;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.scoped(
        awaitApproval(
          { ...first, expiresIn: 6 },
          {
            ask: Effect.suspend(() =>
              ++calls === 1
                ? Effect.fail(failure(true))
                : Effect.succeed({ approval: { ...first, expiresIn: 600 } }),
            ),
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
      yield* TestClock.adjust('6 seconds');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(calls).toBe(2);
  expect(code).toBe(75);
});
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
it('E7: delivery closes the wait and returns exact redacted values', async () => {
  const delivered = {
    values: [{ path: first.paths[0], value: Redacted.make('synthetic-only') }],
  };
  let received: unknown;
  await Effect.runPromise(
    Effect.gen(function* () {
      const fiber = yield* Effect.scoped(
        awaitApproval(first, {
          ask: Effect.succeed(delivered),
          withdraw: () => Effect.void,
          status: () => {},
          signal: Effect.never,
        }),
      ).pipe(
        Effect.tap((v) =>
          Effect.sync(() => {
            received = v;
          }),
        ),
        Effect.forkChild,
      );
      yield* TestClock.adjust('2 seconds');
      yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer())),
  );
  expect(received).toBe(delivered);
});
it.each([0, 1])(
  'E9: a later pending answer with %i seconds remaining shortens the local deadline',
  async (expiresIn) => {
    let code = 0;
    await Effect.runPromise(
      Effect.gen(function* () {
        const fiber = yield* Effect.scoped(
          awaitApproval(first, {
            ask: Effect.succeed({ approval: { ...first, expiresIn } }),
            withdraw: () => Effect.void,
            status: () => {},
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
        yield* TestClock.adjust('3 seconds');
        yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer())),
    );
    expect(code).toBe(75);
  },
);
