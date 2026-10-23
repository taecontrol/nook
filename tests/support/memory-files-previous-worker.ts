import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { build } from 'esbuild';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';
import { testBuild } from './runtime.ts';
import { vaultRuntime } from './vault.ts';

// Freeze the accepted delivery base, so later rounds still exercise the actual
// previous Worker against the new schema instead of reimplementing its SQL.
export async function previousFilesWorker() {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'files-previous-worker-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker from ${JSON.stringify(resolve('apps/worker/src/index.ts'))}; export default { ...worker, fetch(request, env, ctx) { if (new URL(request.url).pathname === '/__test/coverage') return Response.json({ seam: 'worker', loaded: {}, counters: {} }); return worker.fetch(request, env, ctx); } };`,
        resolveDir: process.cwd(),
      },
      outfile: resolve(directory, 'worker.js'),
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'],
      target: 'es2023',
      plugins: [
        {
          name: 'accepted-previous-worker',
          setup(builder) {
            builder.onLoad(
              { filter: /\/(?:apps\/worker|packages\/contract)\/src\/.*\.ts$/ },
              (args) => ({
                contents: execFileSync(
                  'git',
                  ['show', `a3b683b:${relative(process.cwd(), args.path)}`],
                  { encoding: 'utf8', env: testEnvironment(process.env.HOME) },
                ),
                loader: 'ts',
                resolveDir: resolve(args.path, '..'),
              }),
            );
          },
        },
      ],
    });
    const app = await vaultRuntime({
      directory,
      r2Buckets: ['FILES'],
      coverageEndpoint: true,
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
