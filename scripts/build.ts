import { build } from 'esbuild';
import { build as buildWeb } from 'vite';

export async function buildProduct(directory = 'dist') {
  await buildWeb({ build: { outDir: `${process.cwd()}/${directory}/assets` } });
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
}

if (import.meta.main) await buildProduct();
