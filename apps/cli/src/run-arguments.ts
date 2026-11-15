import { basename } from 'node:path';
import {
  validateRunSecrets,
  validateSecretPath,
  WriteId,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { isClaimVariable } from './agent-session.ts';
import { type Grammar, parseArguments } from './arguments.ts';
import { CliFailure } from './errors.ts';
import {
  isEnvironmentName,
  type ProjectSecrets,
  requireMappingLimit,
  type SecretMapping,
} from './project-secrets.ts';

export const runGrammar: Grammar = {
  usage:
    'nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] [--approval <id>] -- <command>',
  positional: [],
  flags: {
    secret: 'repeated',
    purpose: 'required',
    'no-masking': 'boolean',
    approval: 'optional',
  },
  rest: 'command',
};
const isAttemptId = Schema.is(WriteId);
function mapping(value: string): Effect.Effect<SecretMapping, CliFailure> {
  return Effect.gen(function* () {
    const separator = value.indexOf('=');
    const name = value.slice(0, separator);
    const path = value.slice(separator + 1);
    if (isClaimVariable(name))
      return yield* Effect.fail(
        new CliFailure(
          `Environment name ${name} is reserved for agent session claims.`,
        ),
      );
    if (!isEnvironmentName(name))
      return yield* Effect.fail(
        new CliFailure(
          'Use --secret ENV=bucket/NAME with a valid environment name and secret path.',
        ),
      );
    const invalid = validateSecretPath(path);
    if (invalid) return yield* Effect.fail(new CliFailure(invalid));
    return { name, path };
  });
}
export function parseRun(
  args: string[],
  workingDirectory: string,
  project?: ProjectSecrets,
) {
  return Effect.gen(function* () {
    const { flags, rest: command } = yield* parseArguments(runGrammar, args);
    const [purpose] = flags.get('purpose') ?? [];
    const secrets = yield* Effect.forEach(flags.get('secret') ?? [], mapping);
    yield* requireUniqueNames(secrets);
    const mappings = yield* mergeMappings(project, secrets);
    const input = {
      purpose,
      workingDirectory,
      executable: basename(command[0]),
      secrets: [...new Set(mappings.map((secret) => secret.path))],
    };
    const invalid = validateRunSecrets(input);
    if (invalid) return yield* Effect.fail(new CliFailure(invalid));
    const [approval] = flags.get('approval') ?? [];
    if (approval !== undefined && !isAttemptId(approval))
      return yield* Effect.fail(
        new CliFailure(
          'Use --approval with the id a previous nook run printed.',
        ),
      );
    return {
      command,
      mappings,
      input,
      masking: !flags.has('no-masking'),
      approval,
    };
  });
}
function mergeMappings(
  project: ProjectSecrets | undefined,
  flags: SecretMapping[],
) {
  return Effect.gen(function* () {
    const entries = new Map(
      (project?.mappings ?? []).map((entry) => [entry.name, entry]),
    );
    for (const entry of flags) entries.set(entry.name, entry);
    const mappings = [...entries.values()];
    if (mappings.length === 0)
      return yield* Effect.fail(
        new CliFailure(
          project
            ? `No secrets are mapped in ${project.file}.`
            : `Usage: ${runGrammar.usage}`,
        ),
      );
    yield* requireMappingLimit(mappings, project?.file);
    return mappings;
  });
}
function requireUniqueNames(mappings: SecretMapping[]) {
  return Effect.gen(function* () {
    const names = new Set<string>();
    for (const { name } of mappings) {
      if (names.has(name))
        return yield* Effect.fail(
          new CliFailure(`Environment name ${name} is repeated.`),
        );
      names.add(name);
    }
  });
}
