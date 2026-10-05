import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { build as buildWeb } from 'vite';
import {
  coveragePlugin,
  instrumentModule,
  inventory,
} from './lib/instrument.ts';

export async function buildTest() {
  const directory = resolve('.local/test-build');
  await mkdir(directory, { recursive: true });
  const entry = resolve(directory, 'worker-entry.js');
  await writeFile(
    entry,
    `import worker from ${JSON.stringify(resolve('apps/worker/src/index.ts'))}; export default { fetch(request, env) { if (new URL(request.url).pathname === '/__test/coverage') return Response.json({ seam: 'worker', loaded: globalThis.__authoredModules__ ?? {}, counters: globalThis.__coverage__ ?? {} }); return worker.fetch(request, env); } };`,
  );
  const scoped = new Set((await inventory()).map((path) => resolve(path)));
  await build({
    entryPoints: [entry],
    outfile: resolve(directory, 'worker.js'),
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
    target: 'es2023',
    plugins: [
      {
        name: 'nook-worker-coverage',
        setup(builder) {
          builder.onLoad({ filter: /\.tsx?$/ }, async ({ path }) =>
            scoped.has(path)
              ? {
                  contents: await instrumentModule(
                    path.slice(process.cwd().length + 1),
                  ),
                  loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
                }
              : undefined,
          );
        },
      },
    ],
  });
  await buildWeb({
    plugins: [coveragePlugin()],
    build: { outDir: resolve(directory, 'assets') },
  });
  const cliEntry = resolve(directory, 'cli-entry.js');
  await writeFile(
    cliEntry,
    `import { writeFileSync } from 'node:fs'; process.once('exit', () => writeFileSync(process.env.NOOK_CLI_COVERAGE, JSON.stringify({ seam: 'cli', loaded: globalThis.__authoredModules__ ?? {}, counters: globalThis.__coverage__ ?? {} }))); await import(${JSON.stringify(resolve('apps/cli/src/index.ts'))});`,
  );
  await build({
    entryPoints: [cliEntry],
    outfile: resolve(directory, 'cli.js'),
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    external: ['node:*'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    plugins: [
      {
        name: 'nook-cli-coverage',
        setup(builder) {
          builder.onLoad({ filter: /\.tsx?$/ }, async ({ path }) =>
            scoped.has(path)
              ? {
                  contents: await instrumentModule(
                    path.slice(process.cwd().length + 1),
                  ),
                  loader: path.endsWith('.tsx') ? 'tsx' : 'ts',
                }
              : undefined,
          );
        },
      },
    ],
  });
}
