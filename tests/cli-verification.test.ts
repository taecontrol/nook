import { readFile } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { parse } from 'yaml';

it('E26: CLI enters complexity and coverage scope, and CI installs a real Secret Service', async () => {
  const config = JSON.parse(await readFile('coverage.config.json', 'utf8'));
  expect(config.roots).toContain('apps/cli/src');
  expect(config.complexityRoots).toContain('apps/cli/src');
  expect(config.maximum).toBe(8);
  const workflow = parse(
    await readFile('.github/workflows/verify.yml', 'utf8'),
  );
  const commands = workflow.jobs.tests.steps
    .map((step: { run?: string }) => step.run ?? '')
    .join('\n');
  for (const dependency of ['gnome-keyring', 'libsecret-tools', 'dbus'])
    expect(commands).toContain(dependency);
  expect(await readFile('scripts/test-build.ts', 'utf8')).toContain('cli');
  expect(await readFile('scripts/lib/coverage-evidence.ts', 'utf8')).toContain(
    'cli',
  );
});

it('E12: every CI test shard installs bubblewrap and loads only the versioned executable profile before coverage', async () => {
  const workflow = parse(
    await readFile('.github/workflows/verify.yml', 'utf8'),
  );
  const commands: string[] = workflow.jobs.tests.steps.map(
    (step: { run?: string }) => step.run ?? '',
  );
  const install = commands.findIndex((command) =>
    /apt-get install.*\bbubblewrap\b/.test(command),
  );
  const profile = commands.indexOf(
    'sudo apparmor_parser -r .github/apparmor/nook-bwrap',
  );
  const coverage = commands.findIndex((command) =>
    command.startsWith('pnpm test:coverage'),
  );
  expect(install).toBeGreaterThanOrEqual(0);
  expect(profile).toBeGreaterThan(install);
  expect(coverage).toBeGreaterThan(profile);
  expect(workflow.jobs.tests.strategy.matrix.shard).toEqual([1, 2, 3]);
  expect(commands.join('\n')).not.toMatch(
    /sysctl.*apparmor_restrict_unprivileged_userns/,
  );
  const policy = await readFile('.github/apparmor/nook-bwrap', 'utf8');
  expect(policy.replace(/\s+/g, ' ').trim()).toBe(
    'abi <abi/4.0>, include <tunables/global> profile nook-bwrap /usr/bin/bwrap flags=(unconfined) { userns, }',
  );
});
