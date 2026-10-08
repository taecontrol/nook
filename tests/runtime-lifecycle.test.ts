import { spawnSync } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import type { Readable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { build } from 'esbuild';
import { expect, it, vi } from 'vitest';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import * as observation from '../scripts/observation.ts';
import { startRuntime } from '../scripts/runtime.ts';
import {
  createAuthorization,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import {
  closingClientRuntime,
  coverageRuntime,
} from './support/coverage-runtime.ts';
import { runtime, testBuild } from './support/runtime.ts';

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

async function loggingRuntime() {
  const directory = await mkdtemp(resolve('.local', 'logging-runtime-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker from ${JSON.stringify(resolve(testBuild, 'worker.js'))};
export default { async fetch(request, env) {
  console.log(env.LOG_STEP + ':stdout');
  console.error(env.LOG_STEP + ':stderr');
  const original = await worker.fetch(request, env);
  const response = new Response(original.body, original);
  response.headers.set('X-Test-Outbound', await (await fetch('https://runtime-output.invalid')).text());
  return response;
} };`,
        resolveDir: process.cwd(),
      },
      outfile: resolve(directory, 'worker.js'),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'],
      target: 'es2023',
    });
    const app = await runtime({
      directory,
      outboundService: async () => new Response('initial outbound service'),
    });
    return {
      ...app,
      async close() {
        try {
          await app.close();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

function captureRuntimeOutput() {
  const output = ['', ''];
  const overrides = {
    handleRuntimeStdio: (stdout: Readable, stderr: Readable) => {
      [stdout, stderr].forEach((stream, index) => {
        stream.setEncoding('utf8');
        stream.on('data', (chunk) => {
          output[index] += String(chunk);
        });
      });
    },
  };
  return { output, overrides };
}

it('runtime binding updates preserve output observers and explicit option replacements or resets', async () => {
  const app = await loggingRuntime();
  const first = captureRuntimeOutput();
  const replacement = captureRuntimeOutput();
  const defaultOutput: string[] = [];
  const stdout = vi.spyOn(console, 'log').mockImplementation((message) => {
    defaultOutput.push(String(message));
  });
  const stderr = vi.spyOn(console, 'error').mockImplementation((message) => {
    defaultOutput.push(String(message));
  });
  const bindings = { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin };
  async function request(step: string, output: string[], outbound: string) {
    const response = await fetch(`${app.origin}/api/whoami`);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Test-Outbound')).toBe(outbound);
    await response.body?.cancel();
    for (const stream of ['stdout', 'stderr'])
      await expect
        .poll(() => output.join('\n').includes(`${step}:${stream}`))
        .toBe(true);
  }
  try {
    await app.setBindings({ ...bindings, LOG_STEP: 'before' }, first.overrides);
    await request('before', first.output, 'initial outbound service');
    await app.setBindings({ ...bindings, LOG_STEP: 'after' });
    await request('after', first.output, 'initial outbound service');
    await app.setBindings(
      { ...bindings, LOG_STEP: 'replacement' },
      {
        ...replacement.overrides,
        outboundService: async () =>
          new Response('replacement outbound service'),
      },
    );
    await request(
      'replacement',
      replacement.output,
      'replacement outbound service',
    );
    expect(first.output.join('\n')).not.toContain('replacement:');
    await app.setBindings(
      { ...bindings, LOG_STEP: 'reset' },
      { handleRuntimeStdio: undefined },
    );
    await request('reset', defaultOutput, 'replacement outbound service');
    expect(replacement.output.join('\n')).not.toContain('reset:');
  } finally {
    try {
      await app.close();
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
    }
  }
});

it('a failed runtime update retains the last successful output observer', async () => {
  const app = await loggingRuntime();
  const captured = captureRuntimeOutput();
  const bindings = { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin };
  try {
    await app.setBindings(
      { ...bindings, LOG_STEP: 'before' },
      captured.overrides,
    );
    await expect(
      app.setBindings(
        { ...bindings, LOG_STEP: 'failed' },
        {
          handleRuntimeStdio: () => {
            throw new Error('Synthetic output observer update failure.');
          },
        },
      ),
    ).rejects.toThrow('Synthetic output observer update failure.');
    await app.setBindings({ ...bindings, LOG_STEP: 'recovered' });
    const response = await fetch(`${app.origin}/api/whoami`);
    expect(response.status).toBe(200);
    expect(response.headers.get('X-Test-Outbound')).toBe(
      'initial outbound service',
    );
    await response.body?.cancel();
    for (const stream of ['stdout', 'stderr'])
      await expect
        .poll(() => captured.output.join('\n').includes(`recovered:${stream}`))
        .toBe(true);
  } finally {
    await app.close();
  }
});

it('fixture API requests survive a public connection that cannot be reused', async () => {
  vi.mocked(startRuntime).mockImplementationOnce(closingClientRuntime);
  const app = await ownerRuntime(await runtime());
  try {
    const first = await createAuthorization(app);
    const second = await createAuthorization(app);
    expect(first.deviceCode !== second.deviceCode).toBe(true);
    const denied = await jsonRequest(
      app,
      `/api/authorizations/${first.userCode}/deny`,
    );
    expect(denied.status).toBe(204);
    const row = await (await app.mf.getD1Database('DB'))
      .prepare(
        "SELECT count(*) AS count FROM authorizations WHERE status='pending'",
      )
      .first();
    expect(row?.count).toBe(1);
  } finally {
    await app.close();
  }
});

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

it('coverage capture survives a closed public-client connection and records the real Worker counters', async () => {
  vi.stubEnv('COVERAGE_RUN', 'fixture');
  vi.mocked(startRuntime).mockImplementationOnce(closingClientRuntime);
  const captured = vi.spyOn(observation, 'observe');
  const app = await coverageRuntime();
  const port = new URL(app.origin).port;
  let needsClose = true;
  try {
    const response = await fetch(`${app.origin}/api/whoami`);
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ _tag: 'Unauthorized' });
    const expected = await (
      await app.mf.dispatchFetch(`${app.origin}/__test/coverage`)
    ).json();
    await setImmediate();
    needsClose = false;
    await app.close();
    expect(captured).toHaveBeenCalledWith(expected);
    await expect(stat(leasePath(port))).rejects.toMatchObject({
      code: 'ENOENT',
    });
    await expect(fetch(`${app.origin}/api/whoami`)).rejects.toThrow();
  } finally {
    if (needsClose) await app.close();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  }
});

it('a failed coverage capture still closes workerd and releases its port lease', async () => {
  vi.stubEnv('COVERAGE_RUN', 'fixture');
  const app = await coverageRuntime(true);
  const port = new URL(app.origin).port;
  let needsClose = true;
  try {
    needsClose = false;
    await expect(app.close()).rejects.toThrow(SyntaxError);
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
