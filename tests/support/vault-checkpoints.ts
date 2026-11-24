import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { testBuild } from './runtime.ts';
import { vaultRuntime } from './vault.ts';

export async function vaultCheckpoints(
  onCheckpoint: (label: string) => Promise<boolean>,
  grant?: readonly string[],
  observeRequests = false,
  options: {
    observeStatements?: boolean;
    observeBatchSize?: boolean;
    failBatchStatement?: number;
    failBatchSize?: number;
    omitIp?: boolean;
    now?: number;
  } = {},
) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'vault-checkpoints-'));
  let now = options.now;
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker${grant ? ', { handlerForPrincipal }' : ''} from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; import { vaultCheckpointWorker } from ${JSON.stringify(resolve('tests/support/vault-checkpoint-worker.ts'))}; export default vaultCheckpointWorker(${grant ? `{ fetch(request, env) { if (new URL(request.url).pathname === '/__test/coverage') return worker.fetch(request, env); return handlerForPrincipal('owner@nook.test', env.DB, ${JSON.stringify(grant)}, env.VAULT_KEY)(request); } }` : 'worker'}, ${observeRequests}, ${JSON.stringify(options)});`,
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
    const app = await vaultRuntime({
      directory,
      outboundService: async (request) => {
        const label = new URL(request.url).pathname;
        if (label === '/clock' && now !== undefined) return Response.json(now);
        return new Response('synthetic checkpoint', {
          status: (await onCheckpoint(label)) ? 200 : 503,
        });
      },
    });
    return {
      ...app,
      setTime(value: number) {
        now = value;
      },
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
