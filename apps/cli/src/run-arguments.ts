import { basename } from 'node:path';
import { validateRunSecrets, validateSecretPath } from '@nook/contract';
import { type Grammar, parseArguments } from './arguments.ts';
import { CliFailure } from './errors.ts';
import {
  isEnvironmentName,
  type ProjectSecrets,
  requireMappingLimit,
  type SecretMapping,
} from './project-secrets.ts';

export const runGrammar: Grammar = {
  usage: 'nook run --secret ENV=bucket/NAME --purpose "…" -- <command>',
  positional: [],
  flags: { secret: 'repeated', purpose: 'required' },
  rest: 'command',
};
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
export function parseRun(
  args: string[],
  workingDirectory: string,
  project?: ProjectSecrets,
) {
  const { flags, rest: command } = parseArguments(runGrammar, args);
  const [purpose] = flags.get('purpose') ?? [];
  const secrets = (flags.get('secret') ?? []).map(mapping);
  requireUniqueNames(secrets);
  const mappings = mergeMappings(project, secrets);
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
      project
        ? `No secrets are mapped in ${project.file}.`
        : `Usage: ${runGrammar.usage}`,
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
