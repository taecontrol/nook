import { fileURLToPath } from 'node:url';
import { build, stop } from 'esbuild';

// Bundles only the CLI: packaging needs neither the web app nor host isolation.
export function buildCli(outfile: string, sourcemap = false) {
  return build({
    entryPoints: [
      fileURLToPath(new URL('../apps/cli/src/index.ts', import.meta.url)),
    ],
    outfile,
    bundle: true,
    format: 'esm',
    platform: 'node',
    target: 'node26',
    external: ['node:*'],
    banner: {
      js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
    },
    sourcemap,
  });
}

if (import.meta.main) {
  try {
    await buildCli(process.argv[2] ?? 'dist/cli.js');
  } finally {
    stop();
  }
}
