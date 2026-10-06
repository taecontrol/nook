import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { CliFailure, keyringMessage } from './errors.ts';

export function keyringCommand(
  tool: string,
  args: string[],
  timeout: '10 seconds' | '2 minutes',
  input = '',
) {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make(tool, args, {
          stdin: Stream.make(new TextEncoder().encode(input)),
          stderr: 'pipe',
        }),
      );
      const [output, status, diagnostic] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          child.exitCode,
          // Diagnostics can echo stdin. Retain only their presence, never bytes.
          Stream.runFold(
            child.stderr,
            () => false,
            (present, chunk) => present || chunk.length > 0,
          ),
        ],
        { concurrency: 'unbounded' },
      );
      return { output: output.trim(), status: Number(status), diagnostic };
    }),
  ).pipe(
    Effect.timeout(timeout),
    Effect.mapError(() => new CliFailure(keyringMessage)),
  );
}

export function requireKeyringSuccess(result: { status: number }) {
  return result.status === 0
    ? Effect.void
    : Effect.fail(new CliFailure(keyringMessage));
}
