import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import { runtime, testBuild } from './runtime.ts';

export async function checkpointRuntime(
  onCheckpoint: (label: string) => Promise<void>,
  options: { principalGrant?: readonly string[] } = {},
) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'd1-checkpoints-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker${options.principalGrant ? ', { handlerForPrincipal }' : ''} from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; import { checkpointWorker } from ${JSON.stringify(resolve('tests/support/checkpoint-worker.ts'))}; export default checkpointWorker(${options.principalGrant ? `{ fetch(request, env) { if (new URL(request.url).pathname === '/__test/coverage') return worker.fetch(request, env); return handlerForPrincipal('owner@nook.test', env.DB, ${JSON.stringify(options.principalGrant)})(request); } }` : 'worker'});`,
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
      outboundService: async (request) => {
        await onCheckpoint(new URL(request.url).pathname);
        return new Response('ok');
      },
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
