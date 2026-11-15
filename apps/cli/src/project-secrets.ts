import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  validateSecretPath,
  validateSecretPaths,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect } from 'effect';
import { isClaimVariable } from './agent-session.ts';
import { CliFailure } from './errors.ts';

export type SecretMapping = { name: string; path: string };
export type ProjectSecrets = { file: string; mappings: SecretMapping[] };
export const currentDirectory = Effect.tryPromise({
  try: () => realpath(process.cwd()),
  catch: () => new CliFailure('Could not resolve the working directory.'),
});
export const writeDirectory = currentDirectory.pipe(
  Effect.flatMap((directory) => {
    const message = validateWorkingDirectory(directory);
    return message
      ? Effect.fail(new CliFailure(message))
      : Effect.succeed(directory);
  }),
);
export const isEnvironmentName = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
function invalidFile(file: string, message: string) {
  return new CliFailure(`Invalid ${file}: ${message}`);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function entry(
  file: string,
  name: string,
  path: unknown,
): Effect.Effect<SecretMapping, CliFailure> {
  return Effect.gen(function* () {
    if (isClaimVariable(name))
      return yield* Effect.fail(
        new CliFailure(
          `Environment name ${name} is reserved for agent session claims.`,
        ),
      );
    if (!isEnvironmentName(name))
      return yield* Effect.fail(
        invalidFile(file, `invalid environment name ${JSON.stringify(name)}.`),
      );
    if (typeof path !== 'string')
      return yield* Effect.fail(
        invalidFile(file, `secret path for ${name} must be a string.`),
      );
    if (validateSecretPath(path))
      return yield* Effect.fail(
        invalidFile(file, `invalid secret path for ${name}.`),
      );
    return { name, path };
  });
}
function parseFile(
  file: string,
  content: string,
): Effect.Effect<ProjectSecrets, CliFailure> {
  return Effect.gen(function* () {
    const value: unknown = yield* Effect.try({
      try: () => JSON.parse(content),
      catch: () => invalidFile(file, 'malformed JSON.'),
    });
    if (!isObject(value))
      return yield* Effect.fail(invalidFile(file, 'expected an object.'));
    for (const key of Object.keys(value))
      if (key !== 'secrets')
        return yield* Effect.fail(
          invalidFile(file, `unknown key ${JSON.stringify(key)}.`),
        );
    if (!isObject(value.secrets))
      return yield* Effect.fail(
        invalidFile(file, 'secrets must be an object.'),
      );
    return {
      file,
      mappings: yield* Effect.forEach(
        Object.entries(value.secrets),
        ([name, path]) => entry(file, name, path),
      ),
    };
  });
}
export function projectSecrets(directory: string) {
  return Effect.gen(function* () {
    let current = directory;
    while (true) {
      const file = join(current, 'nook.json');
      const content = yield* Effect.tryPromise({
        try: async () => {
          try {
            return await readFile(file, 'utf8');
          } catch (error) {
            if (
              error instanceof Error &&
              'code' in error &&
              error.code === 'ENOENT'
            )
              return undefined;
            throw error;
          }
        },
        catch: () => new CliFailure(`Could not read ${file}.`),
      });
      if (content !== undefined) return yield* parseFile(file, content);
      const parent = dirname(current);
      if (parent === current) return;
      current = parent;
    }
  });
}
// File entries are validated before merging; the request limit applies afterwards.
export function requireMappingLimit(mappings: SecretMapping[], file?: string) {
  return Effect.gen(function* () {
    if (mappings.length === 0) return;
    const invalid = validateSecretPaths(mappings.map(({ path }) => path));
    if (invalid)
      return yield* Effect.fail(
        file
          ? invalidFile(file, 'secrets must map at most 20 distinct paths.')
          : new CliFailure(invalid),
      );
  });
}
