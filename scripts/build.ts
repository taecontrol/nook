import { build, stop } from 'esbuild';
import { build as buildWeb } from 'vite';
import { startHostIsolation } from './lib/host-isolation.ts';

export async function buildProduct(directory = 'dist') {
  try {
    await buildWeb({
      build: { outDir: `${process.cwd()}/${directory}/assets` },
    });
    await build({
      entryPoints: ['apps/worker/src/index.ts'],
      outfile: `${directory}/worker.js`,
      bundle: true,
      format: 'esm',
      platform: 'neutral',
      conditions: ['workerd', 'worker', 'browser'],
      external: ['node:*', 'cloudflare:*'],
      target: 'es2023',
      sourcemap: true,
    });
    await build({
      entryPoints: ['apps/cli/src/index.ts'],
      outfile: `${directory}/cli.js`,
      bundle: true,
      format: 'esm',
      platform: 'node',
      target: 'node26',
      external: ['node:*'],
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      sourcemap: true,
    });
  } finally {
    stop();
  }
}

if (import.meta.main) {
  const isolation = await startHostIsolation();
  try {
    await buildProduct();
  } finally {
    await isolation.close();
  }
}
