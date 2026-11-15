import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Cause, Effect, Exit } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { parseArguments } from '../apps/cli/src/arguments.ts';
import { installationOrigin, readConfig } from '../apps/cli/src/config.ts';
import {
  projectSecrets,
  requireMappingLimit,
} from '../apps/cli/src/project-secrets.ts';
import { parseRun, runGrammar } from '../apps/cli/src/run-arguments.ts';
import { resolveCommand } from '../apps/cli/src/run-command.ts';
import { parseCreate } from '../apps/cli/src/vault-create-arguments.ts';
import { parseImport } from '../apps/cli/src/vault-import-arguments.ts';

const claims = vi.hoisted(() => ({ broken: false }));
vi.mock('../apps/cli/src/agent-session.ts', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../apps/cli/src/agent-session.ts')>();
  return {
    ...actual,
    isClaimVariable: (name: string) => {
      if (claims.broken) throw new TypeError('A programming error.');
      return actual.isClaimVariable(name);
    },
  };
});

const directories: string[] = [];
afterEach(async () => {
  claims.broken = false;
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryDirectory() {
  const directory = await mkdtemp(join(tmpdir(), 'nook-expected-failures-'));
  directories.push(directory);
  return directory;
}
async function expectDefect(effect: Effect.Effect<unknown, unknown>) {
  const exit = await Effect.runPromiseExit(effect);
  expect(Exit.isFailure(exit)).toBe(true);
  if (Exit.isFailure(exit)) {
    expect(Cause.hasDies(exit.cause)).toBe(true);
    expect(Cause.hasFails(exit.cause)).toBe(false);
    expect(Cause.squash(exit.cause)).toBeInstanceOf(TypeError);
  }
}

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
    await expectDefect(evaluate());
  },
);

it('projectSecrets keeps a validation bug after a successful read a defect', async () => {
  const directory = await temporaryDirectory();
  await writeFile(
    join(directory, 'nook.json'),
    JSON.stringify({ secrets: { TOKEN: 'work/acme/TOKEN' } }),
  );
  claims.broken = true;
  await expectDefect(projectSecrets(directory));
});

it('readConfig keeps a validation bug after a successful read a defect', async () => {
  const directory = await temporaryDirectory();
  await mkdir(join(directory, 'nook'));
  await writeFile(
    join(directory, 'nook', 'config.json'),
    JSON.stringify({ url: 'https://nook.example.com' }),
  );
  vi.stubEnv('XDG_CONFIG_HOME', directory);
  vi.spyOn(URL, 'parse').mockImplementation(() => {
    throw new TypeError('A programming error.');
  });
  await expectDefect(readConfig);
});
