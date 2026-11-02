import { randomUUID } from 'node:crypto';
import { validateWorkingDirectory } from '@nook/contract';
import { Effect } from 'effect';
import { CliFailure, tryCli } from './errors.ts';
import type { Host } from './host.ts';
import { currentDirectory } from './project-secrets.ts';
import { readSecretInput } from './secret-input.ts';
import { createSecretOnce, createSession } from './secret-write.ts';
import { parseCreate } from './vault-create-arguments.ts';

export function vaultCreate(
  host: Host,
  args: readonly string[],
  write: (message: string) => void,
) {
  return Effect.gen(function* () {
    const parsed = yield* tryCli(() => parseCreate(args));
    const workingDirectory = yield* currentDirectory;
    const message = validateWorkingDirectory(workingDirectory);
    if (message) return yield* Effect.fail(new CliFailure(message));
    const value = yield* readSecretInput(parsed.path);
    const { request } = yield* createSession(host);
    const outcome = yield* createSecretOnce(
      request,
      { ...parsed, value, writeId: randomUUID(), workingDirectory },
      parsed.path,
    );
    if (outcome._tag !== 'Created') {
      const message =
        outcome._tag === 'Exists'
          ? `${parsed.path} already exists.`
          : outcome._tag === 'Unconfirmed'
            ? `Could not confirm whether ${parsed.path} was stored.`
            : outcome.message;
      return yield* Effect.fail(new CliFailure(message));
    }
    write(`Stored ${parsed.path}.`);
  });
}
