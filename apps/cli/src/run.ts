import { NodeServices } from '@effect/platform-node';
import { Effect, Redacted } from 'effect';
import { CliFailure, networkError, type RequestFailure } from './errors.ts';
import { currentDirectory, projectSecrets } from './project-secrets.ts';
import { parseRun } from './run-arguments.ts';
import { CommandFailure, resolveCommand, runCommand } from './run-command.ts';
import { session } from './session.ts';

function runFailure(error: RequestFailure) {
  if (error.server.tag === 'SecretsForbidden')
    return new CliFailure(
      error.server.paths
        .map((path) => `Access to ${path} is forbidden.`)
        .join(' '),
    );
  if (
    ['SecretNotFound', 'SecretKeyUnavailable', 'VaultNotConfigured'].includes(
      error.server.tag,
    ) &&
    error.publicMessage
  )
    return new CliFailure(error.publicMessage);
  return error;
}
export function run(args: string[], write: (message: string) => void) {
  return Effect.runPromise(
    Effect.gen(function* () {
      const workingDirectory = yield* currentDirectory;
      const project = yield* projectSecrets(workingDirectory);
      const parsed = yield* Effect.try({
        try: () => parseRun(args, workingDirectory, project),
        catch: (error) => error as CliFailure,
      });
      const file = yield* resolveCommand(parsed.command[0]);
      const { url, request } = yield* session;
      const delivered = yield* request((api, headers) =>
        api.machine.values({
          headers,
          payload: parsed.input,
        }),
      ).pipe(Effect.mapError(runFailure));
      const values = new Map(
        delivered.values.map(({ path, value }) => [path, value]),
      );
      const env: NodeJS.ProcessEnv = Object.assign(
        Object.create(null),
        process.env,
      );
      for (const { name, path } of parsed.mappings) {
        const value = values.get(path);
        if (!value) return yield* Effect.fail(networkError(url));
        env[name] = Redacted.value(value);
      }
      return yield* runCommand(file, parsed.command, env);
    }).pipe(
      Effect.provide(NodeServices.layer),
      Effect.catch((error) => {
        write(error.message);
        return Effect.succeed(error instanceof CommandFailure ? error.code : 1);
      }),
    ),
  );
}
