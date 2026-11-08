import type { ApprovalPending, DeliveredSecrets } from '@nook/contract';
import { Clock, Deferred, Effect, Fiber, type Scope } from 'effect';
import { CliFailure, type RequestFailure } from './errors.ts';

export class ApprovalStopped extends CliFailure {
  constructor(
    message: string,
    readonly code: 75 | 77 | 130 | 143,
  ) {
    super(message);
  }
}
export function approvalFailure(error: RequestFailure) {
  switch (error.server.tag) {
    case 'ApprovalDenied':
      return new ApprovalStopped(
        `The owner denied ${error.server.paths.join(', ')}. Nothing was delivered.`,
        77,
      );
    case 'ApprovalExpired':
      return expired();
    case 'ApprovalLimit':
      return new ApprovalStopped(
        error.publicMessage ??
          'Too many pending approval requests. Run again after one finishes.',
        75,
      );
    default:
      return error;
  }
}
function expired() {
  return new ApprovalStopped(
    'The approval request expired. Run again to ask again.',
    75,
  );
}
export type WaitIo = {
  ask: Effect.Effect<
    typeof DeliveredSecrets.Type | ApprovalPending,
    RequestFailure
  >;
  withdraw: (id: string) => Effect.Effect<void, unknown>;
  status: (line: string) => void;
  signal: Effect.Effect<'SIGINT' | 'SIGTERM', never, Scope.Scope>;
};
function timeLeft(seconds: number) {
  const rounded = Math.max(0, Math.ceil(seconds));
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}
function announce(approval: ApprovalPending['approval'], io: WaitIo) {
  io.status(
    `${approval.paths.join(', ')} needs the owner's approval.\nAsk the owner to open ${approval.url}\nWaiting (${timeLeft(approval.expiresIn)} left)…`,
  );
}
function waitLoop(first: ApprovalPending['approval'], io: WaitIo) {
  return Effect.gen(function* () {
    let current = first;
    let deadline = (yield* Clock.currentTimeMillis) + first.expiresIn * 1000;
    let lastStatus = yield* Clock.currentTimeMillis;
    while (true) {
      const remaining = deadline - (yield* Clock.currentTimeMillis);
      if (remaining <= 0) return yield* Effect.fail(expired());
      yield* Effect.sleep(
        Math.min(Math.max(2, current.interval) * 1000, remaining),
      );
      if ((yield* Clock.currentTimeMillis) >= deadline)
        return yield* Effect.fail(expired());
      const response = yield* io.ask.pipe(
        Effect.mapError(approvalFailure),
        Effect.timeoutOrElse({
          duration: deadline - (yield* Clock.currentTimeMillis),
          orElse: () => Effect.fail(expired()),
        }),
        Effect.catch((error) =>
          error instanceof ApprovalStopped || !error.server.retryable
            ? Effect.fail(error)
            : Effect.succeed(null),
        ),
      );
      if (response && 'values' in response) return response;
      const now = yield* Clock.currentTimeMillis;
      if (response) {
        current = response.approval;
        deadline = Math.min(deadline, now + current.expiresIn * 1000);
      }
      if (now - lastStatus >= 30_000) {
        io.status(`Waiting (${timeLeft((deadline - now) / 1000)} left)…`);
        lastStatus = now;
      }
    }
  });
}
export function awaitApproval(first: ApprovalPending['approval'], io: WaitIo) {
  return Effect.gen(function* () {
    announce(first, io);
    const result = yield* Effect.raceFirst(waitLoop(first, io), io.signal);
    if (typeof result !== 'string') return result;
    return yield* stop(result, first.id, io);
  });
}
function stop(
  signal: 'SIGINT' | 'SIGTERM',
  id: string | undefined,
  io: WaitIo,
) {
  return Effect.gen(function* () {
    if (id)
      yield* io.withdraw(id).pipe(
        Effect.timeout('3 seconds'),
        Effect.catchCause(() => Effect.void),
      );
    return yield* Effect.fail(
      new ApprovalStopped(
        id
          ? 'The approval request was withdrawn. Nothing was delivered.'
          : 'The run was cancelled. Nothing was delivered.',
        signal === 'SIGINT' ? 130 : 143,
      ),
    );
  });
}
export function requestValues(io: WaitIo) {
  return Effect.gen(function* () {
    const asking = yield* io.ask.pipe(Effect.forkScoped);
    const result = yield* Effect.raceFirst(Fiber.join(asking), io.signal);
    if (typeof result === 'string') {
      // The server may already have created a request. Give its first answer a
      // short chance to reveal the id before withdrawing, without starting a child.
      const response = yield* Fiber.join(asking).pipe(
        Effect.timeout('3 seconds'),
        Effect.catchCause(() => Effect.succeed(undefined)),
      );
      return yield* stop(
        result,
        response && 'approval' in response ? response.approval.id : undefined,
        io,
      );
    }
    return 'values' in result
      ? result
      : yield* awaitApproval(result.approval, io);
  });
}
// Registration is a scoped resource, separate from waiting for the signal.
// Keep both listeners until the values phase ends, including during withdrawal.
export const processSignal = Effect.gen(function* () {
  const signal = yield* Deferred.make<'SIGINT' | 'SIGTERM'>();
  const interrupt = () => Deferred.doneUnsafe(signal, Effect.succeed('SIGINT'));
  const terminate = () =>
    Deferred.doneUnsafe(signal, Effect.succeed('SIGTERM'));
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
    }),
    () =>
      Effect.sync(() => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
      }),
  );
  return Deferred.await(signal);
});
