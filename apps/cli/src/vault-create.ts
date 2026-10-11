import { randomUUID } from 'node:crypto';
import {
  type CreateMachineSecret,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect } from 'effect';
import { readConfig } from './config.ts';
import { CliFailure, NotLoggedIn, type RequestFailure } from './errors.ts';
import { currentDirectory } from './project-secrets.ts';
import { readSecretInput } from './secret-input.ts';
import { session } from './session.ts';
import { parseCreate } from './vault-create-arguments.ts';

function refused(error: RequestFailure, path: string) {
  if (error.server.tag === 'Forbidden')
    return new CliFailure(`Access to ${path} is forbidden.`);
  if (error.publicMessage) return new CliFailure(error.publicMessage);
  return error;
}
const createSession = session.pipe(
  Effect.catch((error) =>
    error instanceof NotLoggedIn
      ? readConfig.pipe(
          Effect.flatMap((url) =>
            Effect.fail(
              new CliFailure(
                `This machine's token is no longer valid. Run: nook login ${url ?? '<url>'}`,
              ),
            ),
          ),
        )
      : Effect.fail(error),
  ),
);
function store(input: CreateMachineSecret, path: string) {
  return Effect.gen(function* () {
    const { request } = yield* createSession;
    let unconfirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* request((api, headers) =>
        api.machine.createSecret({
          headers,
          payload: input,
        }),
      ).pipe(Effect.result);
      if (result._tag === 'Success') return;
      if (!result.failure.server.retryable) {
        if (!unconfirmed)
          return yield* Effect.fail(refused(result.failure, path));
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
    const workingDirectory = yield* currentDirectory;
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
