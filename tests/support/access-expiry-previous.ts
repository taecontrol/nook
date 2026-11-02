import { execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { relative, resolve } from 'node:path';
import { build, type Plugin } from 'esbuild';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';
import { runtimeOptions } from '../../scripts/runtime.ts';
import { ownerRuntime } from './authorizations.ts';
import { runtime, testBuild } from './runtime.ts';

// Freeze the delivery base, including its contract, rather than imitating old SQL
// or old client decoding with today's dependencies and source.
const previousSource: Plugin = {
  name: 'machine-expiry-delivery-base',
  setup(builder) {
    builder.onLoad(
      {
        filter:
          /\/(?:apps\/(?:worker|cli)|packages\/contract)\/.*\.(?:ts|json)$/,
      },
      (args) => ({
        contents: execFileSync(
          'git',
          ['show', `466b0e6:${relative(process.cwd(), args.path)}`],
          {
            encoding: 'utf8',
            env: testEnvironment(process.env.HOME),
          },
        ),
        loader: args.path.endsWith('.json') ? 'json' : 'ts',
        resolveDir: resolve(args.path, '..'),
      }),
    );
  },
};
export async function previousMachineBuild() {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'machine-expiry-base-'));
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
      plugins: [previousSource],
    });
    await build({
      entryPoints: ['apps/cli/src/index.ts'],
      outfile: resolve(directory, 'cli.js'),
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node26',
      external: ['node:*'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      plugins: [previousSource],
    });
    return {
      directory,
      close: () => rm(directory, { recursive: true, force: true }),
    };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}
export async function previousMachineWorker(directory: string) {
  const app = await ownerRuntime(
    await runtime({ directory, coverageEndpoint: true }),
  );
  return {
    ...app,
    async upgrade() {
      await app.mf.setOptions(
        runtimeOptions({
          port: Number(new URL(app.origin).port),
          directory: testBuild,
          bindings: {
            LOCAL_OWNER: 'synthetic-owner',
            LOCAL_ORIGIN: app.origin,
          },
          coverage: Boolean(process.env.COVERAGE_RUN),
        }),
      );
    },
  };
}
