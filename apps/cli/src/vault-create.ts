import { randomUUID } from 'node:crypto';
import {
  type CreateMachineSecret,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect } from 'effect';
import { readConfig } from './config.ts';
import {
  CliFailure,
  NotLoggedIn,
  type RequestFailure,
  tryCli,
} from './errors.ts';
import type { Host } from './host.ts';
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
function createSession(host: Host) {
  return session(host).pipe(
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
}
function store(host: Host, input: CreateMachineSecret, path: string) {
  return Effect.gen(function* () {
    const { request } = yield* createSession(host);
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
    yield* store(
      host,
      { ...parsed, value, writeId: randomUUID(), workingDirectory },
      parsed.path,
    );
    write(`Stored ${parsed.path}.`);
  });
}
