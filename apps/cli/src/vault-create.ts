import { randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import {
  type CreateMachineSecret,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect } from 'effect';
import { readConfig } from './config.ts';
import { CliFailure, type ServerFailure } from './errors.ts';
import { readSecretInput } from './secret-input.ts';
import { session } from './session.ts';
import { parseCreate } from './vault-create-arguments.ts';

function reconnect(url: string) {
  return new CliFailure(
    `This machine's token is no longer valid. Run: nook login ${url}`,
  );
}
function refused(error: ServerFailure, path: string, url: string) {
  if (error.tag === 'Unauthorized') return reconnect(url);
  if (error.tag === 'Forbidden')
    return new CliFailure(`Access to ${path} is forbidden.`);
  if (error.message) return new CliFailure(error.message);
  return new CliFailure(`Could not reach ${url}. Try again.`);
}
const createSession = session.pipe(
  Effect.catch((error) =>
    error.message.startsWith('Not logged in.')
      ? readConfig.pipe(
          Effect.flatMap((url) => Effect.fail(reconnect(url ?? '<url>'))),
        )
      : Effect.fail(error),
  ),
);
function store(input: CreateMachineSecret, path: string) {
  return Effect.gen(function* () {
    const { url, token, request } = yield* createSession;
    let unconfirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* request((api) =>
        api.machine.createSecret({
          headers: { authorization: `Bearer ${token}` },
          payload: input,
        }),
      ).pipe(Effect.result);
      if (result._tag === 'Success') return;
      if (!result.failure.retryable) {
        if (!unconfirmed)
          return yield* Effect.fail(refused(result.failure, path, url));
        break;
      }
      unconfirmed = true;
    }
    return yield* Effect.fail(
      new CliFailure(`Could not confirm whether ${path} was stored.`),
    );
  });
}
export function vaultCreate(
  args: readonly string[],
  write: (message: string) => void,
) {
  return Effect.gen(function* () {
    const parsed = yield* Effect.try({
      try: () => parseCreate(args),
      catch: (error) => error as CliFailure,
    });
    const workingDirectory = yield* Effect.tryPromise({
      try: () => realpath(process.cwd()),
      catch: () => new CliFailure('Could not resolve the working directory.'),
    });
    const message = validateWorkingDirectory(workingDirectory);
    if (message) return yield* Effect.fail(new CliFailure(message));
    const value = yield* readSecretInput(parsed.path);
    yield* store(
      { ...parsed, value, writeId: randomUUID(), workingDirectory },
      parsed.path,
    );
    write(`Stored ${parsed.path}.`);
  });
}
