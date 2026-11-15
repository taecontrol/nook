import { Cause, Effect, Exit } from 'effect';
import { expect, it } from 'vitest';
import { parseArguments } from '../apps/cli/src/arguments.ts';
import { installationOrigin } from '../apps/cli/src/config.ts';
import {
  projectSecrets,
  requireMappingLimit,
} from '../apps/cli/src/project-secrets.ts';
import { parseRun, runGrammar } from '../apps/cli/src/run-arguments.ts';
import { resolveCommand } from '../apps/cli/src/run-command.ts';
import { parseCreate } from '../apps/cli/src/vault-create-arguments.ts';
import { parseImport } from '../apps/cli/src/vault-import-arguments.ts';

const entryPoints: Record<string, () => Effect.Effect<unknown, unknown>> = {
  parseArguments: () => parseArguments(runGrammar, null as never),
  parseRun: () => parseRun(null as never, '/x'),
  parseCreate: () => parseCreate(null as never),
  parseImport: () => parseImport(null as never),
  projectSecrets: () => projectSecrets(null as never),
  requireMappingLimit: () => requireMappingLimit(null as never),
  resolveCommand: () => resolveCommand(null as never),
  installationOrigin: () => installationOrigin(Object.create(null)),
};

it.each(Object.entries(entryPoints))(
  '%s preserves a programming TypeError as a defect before I/O',
  async (_, evaluate) => {
    const exit = await Effect.runPromiseExit(evaluate());
    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasDies(exit.cause)).toBe(true);
      expect(Cause.hasFails(exit.cause)).toBe(false);
      expect(Cause.squash(exit.cause)).toBeInstanceOf(TypeError);
    }
  },
);
