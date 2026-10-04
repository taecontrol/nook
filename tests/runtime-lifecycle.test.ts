import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startRuntime } from '../scripts/runtime.ts';
import { runtime } from './support/runtime.ts';

vi.mock('../scripts/runtime.ts', async (original) => {
  const actual = await original<typeof import('../scripts/runtime.ts')>();
  return { ...actual, startRuntime: vi.fn(actual.startRuntime) };
});

const leasePath = (port: number | string) =>
  resolve(tmpdir(), 'nook-test-ports', String(port));

it('a rejected runtime startup releases the acquired port lease', async () => {
  const directory = await mkdtemp(resolve('.local', 'bad-runtime-'));
  const configPath = resolve(directory, 'wrangler.json');
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  config.assets.run_worker_first = true;
  await writeFile(configPath, JSON.stringify(config));
  let port: number | undefined;
  try {
    await expect(runtime({ configPath })).rejects.toThrow(
      'Explicit asset routing required.',
    );
    port = vi.mocked(startRuntime).mock.calls.at(-1)?.[0].port;
    expect(port).toBeTypeOf('number');
    await expect(stat(leasePath(port as number))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    if (port) await rm(leasePath(port), { recursive: true, force: true });
    await rm(directory, { recursive: true, force: true });
  }
});

it('a failed coverage capture still closes workerd and releases its port lease', async () => {
  const app = await runtime();
  const port = new URL(app.origin).port;
  let needsDispose = true;
  try {
    vi.stubEnv('COVERAGE_RUN', 'fixture');
    const capture = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('invalid json'));
    await expect(app.close()).rejects.toThrow(SyntaxError);
    capture.mockRestore();
    await expect(fetch(`${app.origin}/api/whoami`)).rejects.toThrow();
    needsDispose = false;
    await expect(stat(leasePath(port))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  } finally {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    // A failed assertion may follow a successful disposal. Cleanup must not
    // replace that diagnostic with Miniflare's non-idempotent second dispose.
    if (needsDispose) await app.mf.dispose().catch(() => {});
    await rm(leasePath(port), { recursive: true, force: true });
  }
});
