import {
  type Secret,
  splitSecretPath,
  validateBucketPath,
} from '@nook/contract';
import { Effect } from 'effect';
import { CliFailure, type ServerFailure } from './errors.ts';
import {
  currentDirectory,
  projectSecrets,
  requireMappingLimit,
} from './project-secrets.ts';
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
type Availability = Set<string> | 'not found' | "outside this machine's grant";
function availability(
  operation: Effect.Effect<{ secrets: readonly Secret[] }, ServerFailure>,
  url: string,
): Effect.Effect<Availability, CliFailure> {
  return operation.pipe(
    Effect.map(({ secrets }) => new Set(secrets.map(({ path }) => path))),
    Effect.catch((error) => {
      if (error.tag === 'Forbidden')
        return Effect.succeed("outside this machine's grant" as const);
      if (error.tag === 'BucketNotFound')
        return Effect.succeed('not found' as const);
      return Effect.fail(listFailure(error, url));
    }),
  );
}
export function vaultCheck(write: (message: string) => void) {
  return Effect.gen(function* () {
    const directory = yield* currentDirectory;
    const project = yield* projectSecrets(directory);
    if (!project)
      return yield* Effect.fail(
        new CliFailure(`No nook.json in ${directory} or its parents.`),
      );
    yield* Effect.try({
      try: () => requireMappingLimit(project.mappings, project.file),
      catch: (error) => error as CliFailure,
    });
    const buckets = [
      ...new Set(
        project.mappings.map(({ path }) => splitSecretPath(path).bucket),
      ),
    ];
    const count = new Set(project.mappings.map(({ path }) => path)).size;
    const summary = `All ${count} secrets mapped in ${project.file} are available.`;
    if (buckets.length === 0) {
      write(summary);
      return;
    }
    const { url, token, request } = yield* session;
    const listed = new Map(
      yield* Effect.forEach(buckets, (bucket) =>
        availability(
          request((api) =>
            api.machine.secrets({
              headers: { authorization: `Bearer ${token}` },
              query: { bucket },
            }),
          ),
          url,
        ).pipe(Effect.map((found) => [bucket, found] as const)),
      ),
    );
    const problems = project.mappings.flatMap(({ name, path }) => {
      const found = listed.get(splitSecretPath(path).bucket);
      const problem =
        typeof found === 'string'
          ? found
          : found?.has(path)
            ? undefined
            : 'not found';
      return problem ? [`${name}  ${path}  ${problem}`] : [];
    });
    if (problems.length)
      return yield* Effect.fail(new CliFailure(problems.join('\n')));
    write(summary);
  });
}
