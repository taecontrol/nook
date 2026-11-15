import {
  type Secret,
  splitSecretPath,
  validateBucketPath,
} from '@nook/contract';
import { Effect } from 'effect';
import { CliFailure, type RequestFailure, tryCli } from './errors.ts';
import type { Host } from './host.ts';
import {
  currentDirectory,
  projectSecrets,
  requireMappingLimit,
} from './project-secrets.ts';
import { session } from './session.ts';

type BucketListing = readonly Secret[] | 'Forbidden' | 'BucketNotFound';
export function listSecrets(
  request: Effect.Success<ReturnType<typeof session>>['request'],
  bucket: string,
): Effect.Effect<BucketListing, RequestFailure> {
  return request((api, headers) =>
    api.machine.secrets({ headers, query: { bucket } }),
  ).pipe(
    Effect.map(({ secrets }) => secrets),
    Effect.catch((error) => {
      if (error.server.tag === 'Forbidden')
        return Effect.succeed('Forbidden' as const);
      if (error.server.tag === 'BucketNotFound')
        return Effect.succeed('BucketNotFound' as const);
      return Effect.fail(error);
    }),
  );
}
export function vaultList(
  host: Host,
  bucket: string,
  write: (message: string) => void,
) {
  return Effect.gen(function* () {
    const message = validateBucketPath(bucket);
    if (message) return yield* Effect.fail(new CliFailure(message));
    const { request } = yield* session(host);
    const secrets = yield* listSecrets(request, bucket);
    if (typeof secrets === 'string')
      return yield* Effect.fail(
        new CliFailure(
          secrets === 'Forbidden'
            ? 'Access to this bucket is forbidden.'
            : 'Bucket not found.',
        ),
      );
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
export function vaultCheck(host: Host, write: (message: string) => void) {
  return Effect.gen(function* () {
    const directory = yield* currentDirectory;
    const project = yield* projectSecrets(directory);
    if (!project)
      return yield* Effect.fail(
        new CliFailure(`No nook.json in ${directory} or its parents.`),
      );
    yield* tryCli(() => requireMappingLimit(project.mappings, project.file));
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
    const { request } = yield* session(host);
    const listed = new Map(
      yield* Effect.forEach(buckets, (bucket) =>
        listSecrets(request, bucket).pipe(
          Effect.map(
            (found) =>
              [
                bucket,
                typeof found === 'string'
                  ? found
                  : new Set(found.map(({ path }) => path)),
              ] as const,
          ),
        ),
      ),
    );
    const problems = project.mappings.flatMap(({ name, path }) => {
      const found = listed.get(splitSecretPath(path).bucket);
      const problem =
        found === 'Forbidden'
          ? "outside this machine's grant"
          : found === 'BucketNotFound' || !found?.has(path)
            ? 'not found'
            : undefined;
      return problem ? [`${name}  ${path}  ${problem}`] : [];
    });
    if (problems.length)
      return yield* Effect.fail(new CliFailure(problems.join('\n')));
    write(summary);
  });
}
