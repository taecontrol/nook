import { Deferred, Effect } from 'effect';

export type ProcessSignal = 'SIGINT' | 'SIGTERM';

export function signalExitCode(signal: ProcessSignal): 130 | 143 {
  return signal === 'SIGINT' ? 130 : 143;
}

// Registration is a scoped resource, separate from waiting for the signal.
// The listeners stay until the caller's scope closes, so a signal during the
// caller's cleanup is absorbed instead of killing the process. The first
// signal decides the exit code.
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
