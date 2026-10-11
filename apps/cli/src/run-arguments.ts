import { basename } from 'node:path';
import { validateRunSecrets, validateSecretPath } from '@nook/contract';
import { CliFailure } from './errors.ts';
import {
  isEnvironmentName,
  type ProjectSecrets,
  requireMappingLimit,
  type SecretMapping,
} from './project-secrets.ts';

const runUsage =
  'Usage: nook run --secret ENV=bucket/NAME --purpose "…" -- <command>';
function mapping(value: string): SecretMapping {
  const separator = value.indexOf('=');
  const name = value.slice(0, separator);
  const path = value.slice(separator + 1);
  if (!isEnvironmentName(name))
    throw new CliFailure(
      'Use --secret ENV=bucket/NAME with a valid environment name and secret path.',
    );
  const invalid = validateSecretPath(path);
  if (invalid) throw new CliFailure(invalid);
  return { name, path };
}
function options(args: string[]) {
  let purpose: string | undefined;
  const secrets: SecretMapping[] = [];
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
export function parseRun(
  args: string[],
  workingDirectory: string,
  project?: ProjectSecrets,
) {
  const separator = args.indexOf('--');
  if (separator < 0 || separator === args.length - 1)
    throw new CliFailure(runUsage);
  const { purpose, secrets } = options(args.slice(0, separator));
  if (purpose === undefined) throw new CliFailure('A purpose is required.');
  requireUniqueNames(secrets);
  const mappings = mergeMappings(project, secrets);
  const command = args.slice(separator + 1);
  const input = {
    purpose,
    workingDirectory,
    executable: basename(command[0]),
    secrets: [...new Set(mappings.map((secret) => secret.path))],
  };
  const invalid = validateRunSecrets(input);
  if (invalid) throw new CliFailure(invalid);
  return { command, mappings, input };
}
function mergeMappings(
  project: ProjectSecrets | undefined,
  flags: SecretMapping[],
) {
  const entries = new Map(
    (project?.mappings ?? []).map((entry) => [entry.name, entry]),
  );
  for (const entry of flags) entries.set(entry.name, entry);
  const mappings = [...entries.values()];
  if (mappings.length === 0)
    throw new CliFailure(
      project ? `No secrets are mapped in ${project.file}.` : runUsage,
    );
  requireMappingLimit(mappings, project?.file);
  return mappings;
}
function requireUniqueNames(mappings: SecretMapping[]) {
  const names = new Set<string>();
  for (const { name } of mappings) {
    if (names.has(name))
      throw new CliFailure(`Environment name ${name} is repeated.`);
    names.add(name);
  }
}
