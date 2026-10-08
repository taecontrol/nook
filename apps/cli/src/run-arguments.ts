import { basename } from 'node:path';
import { validateRunSecrets } from '@nook/contract';
import { CliFailure } from './errors.ts';
export const runUsage =
  'Usage: nook run --secret ENV=bucket/NAME --purpose "…" -- <command>';
type Mapping = { name: string; path: string };
function mapping(value: string): Mapping {
  const separator = value.indexOf('=');
  const name = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
    throw new CliFailure(
      'Use --secret ENV=bucket/NAME with a valid environment name and secret path.',
    );
  return { name, path };
}
function options(args: string[]) {
  let purpose: string | undefined;
  const secrets: Mapping[] = [];
  for (let index = 0; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (value === undefined) throw new CliFailure(runUsage);
    if (flag === '--secret') secrets.push(mapping(value));
    else if (flag === '--purpose' && purpose === undefined) purpose = value;
    else throw new CliFailure(runUsage);
  }
  return { purpose, secrets };
}
export function parseRun(args: string[], workingDirectory: string) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1)
    throw new CliFailure(runUsage);
  const { purpose, secrets } = options(args.slice(0, separator));
  if (purpose === undefined) throw new CliFailure('A purpose is required.');
  requireUniqueNames(secrets);
  const command = args.slice(separator + 1);
  const input = {
    purpose,
    workingDirectory,
    executable: basename(command[0]),
    secrets: [...new Set(secrets.map((secret) => secret.path))],
  };
  const invalid = validateRunSecrets(input);
  if (invalid) throw new CliFailure(invalid);
  return { command, mappings: secrets, input };
}
function requireUniqueNames(mappings: Mapping[]) {
  const names = new Set<string>();
  for (const { name } of mappings) {
    if (names.has(name))
      throw new CliFailure(`Environment name ${name} is repeated.`);
    names.add(name);
  }
}
