import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { constants as osConstants } from 'node:os';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { CliFailure } from './errors.ts';
export class CommandFailure extends CliFailure {
  constructor(
    readonly code: number,
    name: string,
  ) {
    super(
      code === 127
        ? `Command not found: ${name}`
        : `Command is not executable: ${name}`,
    );
  }
}
function candidateFailure(error: unknown) {
  return ['ENOENT', 'ENOTDIR'].includes(
    (error as NodeJS.ErrnoException).code ?? '',
  )
    ? ('missing' as const)
    : ('denied' as const);
}
function candidate(file: string) {
  return Effect.gen(function* () {
    const info = yield* Effect.tryPromise({
      try: () => stat(file),
      catch: candidateFailure,
    });
    if (!info.isFile()) return 'denied' as const;
    yield* Effect.tryPromise({
      try: () => access(file, constants.X_OK),
      catch: candidateFailure,
    });
    return 'ready' as const;
  }).pipe(Effect.catch((state) => Effect.succeed(state)));
}
export function resolveCommand(
  name: string,
): Effect.Effect<string, CommandFailure> {
  return Effect.gen(function* () {
    const paths = name.includes('/')
      ? [resolve(name)]
      : (process.env.PATH ?? '/usr/bin:/bin')
          .split(':')
          .map((directory) => resolve(directory, name));
    let denied = false;
    for (const path of paths) {
      const state = yield* candidate(path);
      if (state === 'ready') return path;
      if (state === 'denied') denied = true;
    }
    return yield* Effect.fail(new CommandFailure(denied ? 126 : 127, name));
  });
}
function spawnFailure(error: unknown, name: string) {
  return new CommandFailure(
    (error as NodeJS.ErrnoException).code === 'ENOENT' ? 127 : 126,
    name,
  );
}
function childExit(code: number | null, signal: NodeJS.Signals | null) {
  if (code !== null) return code;
  return 128 + (signal ? osConstants.signals[signal] : 0);
}
export function runCommand(
  file: string,
  command: string[],
  env: NodeJS.ProcessEnv,
  stdio: readonly ['inherit', number | 'inherit', number | 'inherit'] = [
    'inherit',
    'inherit',
    'inherit',
  ],
) {
  return Effect.tryPromise({
    try: () => {
      let child: ReturnType<typeof spawn>;
      const interrupt = () => {};
      const terminate = () => {
        child.kill('SIGTERM');
      };
      const hangup = () => {
        child.kill('SIGHUP');
      };
      const cleanup = () => {
        process.off('SIGINT', interrupt);
        process.off('SIGTERM', terminate);
        process.off('SIGHUP', hangup);
      };
      // A child can become ready before a synchronous launcher returns.
      process.on('SIGINT', interrupt);
      process.on('SIGTERM', terminate);
      process.on('SIGHUP', hangup);
      return new Promise<number>((accept, reject) => {
        child = spawn(file, command.slice(1), {
          env,
          stdio: [...stdio],
          argv0: command[0],
        });
        child.once('error', (error) => {
          reject(spawnFailure(error, command[0]));
        });
        child.once('exit', (code, signal) => {
          accept(childExit(code, signal));
        });
      }).finally(cleanup);
    },
    catch: (error) =>
      error instanceof CommandFailure ? error : spawnFailure(error, command[0]),
  });
}
