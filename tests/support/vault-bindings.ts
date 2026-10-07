import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { testBuild } from './runtime.ts';
import { vaultRuntime } from './vault.ts';

// Keep one actual D1 binding and one Worker isolate while changing only the
// supplied key. Miniflare setOptions would restart the isolate and its cache.
export async function vaultBindingRuntime() {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'vault-bindings-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; let database; export default { fetch(request, env) { database ??= env.DB; return worker.fetch(request, { ...env, DB: database, VAULT_KEY: request.headers.has('X-Nook-Test-Missing-Key') ? undefined : env.VAULT_KEY }); } };`,
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
    const app = await vaultRuntime({ directory });
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
