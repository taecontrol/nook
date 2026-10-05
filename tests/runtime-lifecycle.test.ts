import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import { startRuntime } from '../scripts/runtime.ts';
import { runtime } from './support/runtime.ts';

const portSelection = vi.hoisted(() => ({ preferBlocked: false }));
vi.mock('node:crypto', async (original) => {
  const actual = await original<typeof import('node:crypto')>();
  return {
    ...actual,
    randomInt: (minimum: number, maximum: number) =>
      portSelection.preferBlocked && minimum <= 10080 && 10080 < maximum
        ? 10080
        : actual.randomInt(minimum, maximum),
  };
});

vi.mock('../scripts/runtime.ts', async (original) => {
  const actual = await original<typeof import('../scripts/runtime.ts')>();
  return { ...actual, startRuntime: vi.fn(actual.startRuntime) };
});

const leasePath = (port: number | string) =>
  resolve(tmpdir(), 'nook-test-ports', String(port));

async function runFixture(fixture: string, file: string, name: string) {
  const home = await temporaryTestHome();
  const directory = await mkdtemp(resolve('.local', 'runtime-fixture-'));
  const configPath = resolve(directory, 'vitest.config.ts');
  await writeFile(
    configPath,
    `import { defineConfig, mergeConfig } from 'vitest/config';
import base from ${JSON.stringify(resolve('vitest.config.ts'))};
export default mergeConfig(base, defineConfig({
  test: { setupFiles: [${JSON.stringify(resolve('tests/support', fixture))}] },
}));
`,
  );
  try {
    const result = spawnSync(
      'pnpm',
      ['exec', 'vitest', 'run', '--config', configPath, file, '-t', name],
      {
        encoding: 'utf8',
        env: testEnvironment(home, { FORCE_COLOR: '0' }),
      },
    );
    return { status: result.status, output: result.stdout + result.stderr };
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
}

it('a failed bucket beforeEach reports startup without closing the previous runtime again', async () => {
  const result = await runFixture(
    'rejected-bucket-startup.ts',
    'tests/buckets-worker.test.ts',
    'E12 Q20',
  );
  expect(result.status, result.output).toBe(1);
  expect(result.output).toContain('Synthetic bucket runtime startup failure.');
  expect(result.output).toContain('1 passed');
  expect(result.output).not.toContain('ENOENT');
  expect(result.output).not.toContain('rmdir');
});

it('lifecycle cleanup preserves a successor runtime lease after the port is reused', async () => {
  const result = await runFixture(
    'reused-runtime-port.ts',
    'tests/runtime-lifecycle.test.ts',
    '^a failed coverage capture still closes workerd and releases its port lease$',
  );
  expect(result.status, result.output).toBe(0);
  expect(result.output).toContain('1 passed');
});

it('a runtime lease supports real HTTP when randomness prefers a Fetch-blocked port', async () => {
  portSelection.preferBlocked = true;
  let app: Awaited<ReturnType<typeof runtime>> | undefined;
  try {
    app = await runtime();
    expect((await fetch(`${app.origin}/`)).status).toBe(200);
  } finally {
    portSelection.preferBlocked = false;
    await app?.close();
  }
});

it('a rejected runtime startup releases the acquired port lease', async () => {
  const directory = await mkdtemp(resolve('.local', 'bad-runtime-'));
  const configPath = resolve(directory, 'wrangler.json');
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  config.assets.run_worker_first = true;
  await writeFile(configPath, JSON.stringify(config));
  try {
    await expect(runtime({ configPath })).rejects.toThrow(
      'Explicit asset routing required.',
    );
    const port = vi.mocked(startRuntime).mock.calls.at(-1)?.[0].port;
    expect(port).toBeTypeOf('number');
    await expect(stat(leasePath(port as number))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it('a failed coverage capture still closes workerd and releases its port lease', async () => {
  const app = await runtime();
  const port = new URL(app.origin).port;
  let needsClose = true;
  try {
    vi.stubEnv('COVERAGE_RUN', 'fixture');
    const capture = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('invalid json'));
    needsClose = false;
    await expect(app.close()).rejects.toThrow(SyntaxError);
    capture.mockRestore();
    await expect(fetch(`${app.origin}/api/whoami`)).rejects.toThrow();
    await expect(stat(leasePath(port))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // close() disposes and releases in finally, including a failed capture.
    if (needsClose) await app.close();
  }
});
