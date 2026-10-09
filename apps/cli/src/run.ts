import { NodeServices } from '@effect/platform-node';
import { Effect, Redacted } from 'effect';
import { CliFailure, invalidToken, type ServerFailure } from './errors.ts';
import { currentDirectory, projectSecrets } from './project-secrets.ts';
import { parseRun } from './run-arguments.ts';
import { CommandFailure, resolveCommand, runCommand } from './run-command.ts';
import { session } from './session.ts';

function runFailure(error: ServerFailure, url: string) {
  if (error.tag === 'Unauthorized') return invalidToken(url);
  if (error.tag === 'SecretsForbidden')
    return new CliFailure(
      error.paths.map((path) => `Access to ${path} is forbidden.`).join(' '),
    );
  if (
    ['SecretNotFound', 'SecretKeyUnavailable', 'VaultNotConfigured'].includes(
      error.tag,
    ) &&
    error.message
  )
    return new CliFailure(error.message);
  return new CliFailure(`Could not reach ${url}. Try again.`);
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
      const { url, token, request } = yield* session;
      const delivered = yield* request((api) =>
        api.machine.values({
          headers: { authorization: `Bearer ${token}` },
          payload: parsed.input,
        }),
      ).pipe(Effect.mapError((error) => runFailure(error, url)));
      const values = new Map(
        delivered.values.map(({ path, value }) => [path, value]),
      );
      const env: NodeJS.ProcessEnv = Object.assign(
        Object.create(null),
        process.env,
      );
      for (const { name, path } of parsed.mappings) {
        const value = values.get(path);
        if (!value)
          return yield* Effect.fail(
            new CliFailure(`Could not reach ${url}. Try again.`),
          );
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
