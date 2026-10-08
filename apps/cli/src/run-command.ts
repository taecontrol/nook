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
async function candidate(file: string) {
  try {
    if (!(await stat(file)).isFile()) return 'denied';
    await access(file, constants.X_OK);
    return 'ready';
  } catch (error) {
    return ['ENOENT', 'ENOTDIR'].includes(
      (error as NodeJS.ErrnoException).code ?? '',
    )
      ? 'missing'
      : 'denied';
  }
}
export function resolveCommand(name: string) {
  return Effect.tryPromise({
    try: async () => {
      const paths = name.includes('/')
        ? [resolve(name)]
        : (process.env.PATH ?? '/usr/bin:/bin')
            .split(':')
            .map((directory) => resolve(directory, name));
      let denied = false;
      for (const path of paths) {
        const state = await candidate(path);
        if (state === 'ready') return path;
        if (state === 'denied') denied = true;
      }
      throw new CommandFailure(denied ? 126 : 127, name);
    },
    catch: (error) => error as CommandFailure,
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
) {
  return Effect.tryPromise({
    try: () =>
      new Promise<number>((accept, reject) => {
        const child = spawn(file, command.slice(1), {
          env,
          stdio: 'inherit',
          argv0: command[0],
        });
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
        process.on('SIGINT', interrupt);
        process.on('SIGTERM', terminate);
        process.on('SIGHUP', hangup);
        child.once('error', (error) => {
          cleanup();
          reject(spawnFailure(error, command[0]));
        });
        child.once('exit', (code, signal) => {
          cleanup();
          accept(childExit(code, signal));
        });
      }),
    catch: (error) =>
      error instanceof CommandFailure ? error : spawnFailure(error, command[0]),
  });
}
