import { readFile, realpath } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { validateSecretPath, validateSecretPaths } from '@nook/contract';
import { Effect } from 'effect';
import { CliFailure } from './errors.ts';

export type SecretMapping = { name: string; path: string };
export type ProjectSecrets = { file: string; mappings: SecretMapping[] };
export const currentDirectory = Effect.tryPromise({
  try: () => realpath(process.cwd()),
  catch: () => new CliFailure('Could not resolve the working directory.'),
});
export const isEnvironmentName = (name: string) =>
  /^[A-Za-z_][A-Za-z0-9_]*$/.test(name);
function invalidFile(file: string, message: string) {
  return new CliFailure(`Invalid ${file}: ${message}`);
}
function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function entry(file: string, name: string, path: unknown): SecretMapping {
  if (!isEnvironmentName(name))
    throw invalidFile(
      file,
      `invalid environment name ${JSON.stringify(name)}.`,
    );
  if (typeof path !== 'string')
    throw invalidFile(file, `secret path for ${name} must be a string.`);
  if (validateSecretPath(path))
    throw invalidFile(file, `invalid secret path for ${name}.`);
  return { name, path };
}
function parseFile(file: string, content: string): ProjectSecrets {
  let value: unknown;
  try {
    value = JSON.parse(content);
  } catch {
    throw invalidFile(file, 'malformed JSON.');
  }
  if (!isObject(value)) throw invalidFile(file, 'expected an object.');
  for (const key of Object.keys(value))
    if (key !== 'secrets')
      throw invalidFile(file, `unknown key ${JSON.stringify(key)}.`);
  if (!isObject(value.secrets))
    throw invalidFile(file, 'secrets must be an object.');
  return {
    file,
    mappings: Object.entries(value.secrets).map(([name, path]) =>
      entry(file, name, path),
    ),
  };
}
async function discover(directory: string) {
  while (true) {
    const file = join(directory, 'nook.json');
    try {
      return parseFile(file, await readFile(file, 'utf8'));
    } catch (error) {
      if (error instanceof CliFailure) throw error;
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        throw new CliFailure(`Could not read ${file}.`);
    }
    const parent = dirname(directory);
    if (parent === directory) return;
    directory = parent;
  }
}
export function projectSecrets(directory: string) {
  return Effect.tryPromise({
    try: () => discover(directory),
    catch: (error) => error as CliFailure,
  });
}
// File entries are validated before merging; the request limit applies afterwards.
export function requireMappingLimit(mappings: SecretMapping[], file?: string) {
  if (mappings.length === 0) return;
  const invalid = validateSecretPaths(mappings.map(({ path }) => path));
  if (invalid)
    throw file
      ? invalidFile(file, 'secrets must map at most 20 distinct paths.')
      : new CliFailure(invalid);
}
