import { Deferred, Effect } from 'effect';

export type ProcessSignal = 'SIGINT' | 'SIGTERM';

export function signalExitCode(signal: ProcessSignal): 130 | 143 {
  return signal === 'SIGINT' ? 130 : 143;
}

// Registration is a scoped resource, separate from waiting for the signal.
// Keep both listeners until the values phase ends, including during withdrawal.
export const processSignal = Effect.gen(function* () {
  const signal = yield* Deferred.make<ProcessSignal>();
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
