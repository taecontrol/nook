import { validateBucketPath } from '@nook/contract';
import { Effect } from 'effect';
import { CliFailure, type ServerFailure } from './errors.ts';
import { session } from './session.ts';

function listFailure(error: ServerFailure, url: string) {
  if (error.tag === 'Unauthorized')
    return new CliFailure(
      `This machine's token is no longer valid. Run: nook login ${url}`,
    );
  if (error.tag === 'Forbidden')
    return new CliFailure('Access to this bucket is forbidden.');
  if (error.tag === 'BucketNotFound')
    return new CliFailure('Bucket not found.');
  return new CliFailure(`Could not reach ${url}. Try again.`);
}
export function vaultList(bucket: string, write: (message: string) => void) {
  return Effect.gen(function* () {
    const message = validateBucketPath(bucket);
    if (message) return yield* Effect.fail(new CliFailure(message));
    const { url, token, request } = yield* session;
    const { secrets } = yield* request((api) =>
      api.machine.secrets({
        headers: { authorization: `Bearer ${token}` },
        query: { bucket },
      }),
    ).pipe(Effect.mapError((error) => listFailure(error, url)));
    if (secrets.length === 0) {
      write(`No secrets visible from ${bucket}.`);
      return;
    }
    for (const secret of secrets)
      write(
        secret.description
          ? `${secret.path}  ${secret.description}`
          : secret.path,
      );
  });
}
