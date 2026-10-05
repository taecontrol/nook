import { Effect, Stream } from 'effect';
import { ChildProcess, ChildProcessSpawner } from 'effect/process';
import { CliFailure, keyringMessage } from './errors.ts';

function secretTool(args: string[], input = '') {
  return Effect.scoped(
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const child = yield* spawner.spawn(
        ChildProcess.make('secret-tool', args, {
          stdin: Stream.make(new TextEncoder().encode(input)),
          stderr: 'pipe',
        }),
      );
      const [output, status, diagnostic] = yield* Effect.all(
        [
          Stream.mkString(Stream.decodeText(child.stdout)),
          child.exitCode,
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
    Effect.timeout('10 seconds'),
    Effect.mapError(() => new CliFailure(keyringMessage)),
  );
}
function requireSuccess(result: { status: number }) {
  return result.status === 0
    ? Effect.void
    : Effect.fail(new CliFailure(keyringMessage));
}
export const checkKeyring = Effect.gen(function* () {
  const nonce = crypto.randomUUID();
  const stored = yield* secretTool(
    [
      'store',
      '--label=Nook keyring check',
      'service',
      'nook-check',
      'nonce',
      nonce,
    ],
    'ready',
  );
  yield* requireSuccess(stored);
  const cleared = yield* secretTool([
    'clear',
    'service',
    'nook-check',
    'nonce',
    nonce,
  ]);
  yield* requireSuccess(cleared);
});
export function readToken(url: string) {
  return secretTool(['lookup', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap((result) => {
      if (
        result.diagnostic ||
        ![0, 1].includes(result.status) ||
        (result.status === 1 && result.output)
      )
        return Effect.fail(new CliFailure(keyringMessage));
      return Effect.succeed(result.output || undefined);
    }),
  );
}
export function readMachineName(url: string) {
  return secretTool(['search', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap((result) =>
      Effect.try({
        try: () => {
          const label = /^label = Nook machine (.+)$/m.exec(result.output)?.[1];
          const name: unknown = JSON.parse(label ?? 'null');
          if (typeof name !== 'string') throw new Error();
          return name;
        },
        catch: () => new CliFailure(keyringMessage),
      }),
    ),
  );
}
export function storeToken(url: string, machine: string, token: string) {
  return secretTool(
    [
      'store',
      `--label=Nook machine ${JSON.stringify(machine)}`,
      'service',
      'nook',
      'url',
      url,
    ],
    token,
  ).pipe(Effect.flatMap(requireSuccess));
}
export function clearToken(url: string) {
  return secretTool(['clear', 'service', 'nook', 'url', url]).pipe(
    Effect.flatMap(requireSuccess),
  );
}
export function openBrowser(url: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    yield* spawner.exitCode(
      ChildProcess.make('xdg-open', [url], {
        stdin: 'ignore',
        stdout: 'ignore',
        stderr: 'ignore',
      }),
    );
  }).pipe(Effect.timeout('3 seconds'), Effect.ignore);
}
