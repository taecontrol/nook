import type { CreateMachineSecret } from '@nook/contract';
import { Effect } from 'effect';
import { readConfig } from './config.ts';
import { CliFailure, NotLoggedIn, type RequestFailure } from './errors.ts';
import type { Host } from './host.ts';
import { session } from './session.ts';

export type CreateOutcome =
  | { _tag: 'Created' }
  | { _tag: 'Exists' }
  | { _tag: 'Refused'; message: string; bucketWide: boolean }
  | { _tag: 'Unconfirmed' };
type Session = Effect.Success<ReturnType<typeof session>>;

function refused(error: RequestFailure, path: string): CreateOutcome {
  if (error.server.tag === 'SecretExists') return { _tag: 'Exists' };
  return {
    _tag: 'Refused',
    message:
      error.server.tag === 'Forbidden'
        ? `Access to ${path} is forbidden.`
        : (error.publicMessage ?? error.message),
    bucketWide: [
      'Forbidden',
      'BucketNotFound',
      'VaultNotConfigured',
      'Unauthorized',
    ].includes(error.server.tag),
  };
}
export function createSession(host: Host) {
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
export function createSecretOnce(
  request: Session['request'],
  input: CreateMachineSecret,
  path: string,
): Effect.Effect<CreateOutcome> {
  return Effect.gen(function* () {
    let unconfirmed = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* request((api, headers) =>
        api.machine.createSecret({ headers, payload: input }),
      ).pipe(Effect.result);
      if (result._tag === 'Success') return { _tag: 'Created' };
      if (!result.failure.server.retryable) {
        if (!unconfirmed) return refused(result.failure, path);
        break;
      }
      unconfirmed = true;
    }
    return { _tag: 'Unconfirmed' };
  });
}
