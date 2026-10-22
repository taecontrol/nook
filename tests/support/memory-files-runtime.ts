import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import {
  embeddingRecordings,
  SearchStandIns,
} from '../../scripts/search-stand-ins.ts';
import { testBuild } from './runtime.ts';
import { vaultRuntime } from './vault.ts';

export async function filesRuntime(
  options: {
    checkpoint?: (label: string) => Promise<boolean | undefined>;
    now?: number;
    owner?: {
      bindings: Record<string, string>;
      outboundService: (request: Request) => Promise<Response>;
    };
    search?: boolean;
    principalGrant?: string[];
  } = {},
) {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'memory-files-'));
  let now = options.now ?? Date.now();
  const labels: string[] = [];
  const services = options.search
    ? new SearchStandIns(await embeddingRecordings())
    : undefined;
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker${options.principalGrant ? ', { handlerForPrincipal }' : ''} from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; import { memoryFilesWorker } from ${JSON.stringify(resolve('tests/support/memory-files-worker.ts'))}; ${services ? `import { searchWorker } from ${JSON.stringify(resolve('tests/support/search-worker.ts'))};` : ''} const target = ${options.principalGrant ? `{ ...worker, fetch(request, env, ctx) { const path = new URL(request.url).pathname; if (path.startsWith('/api/machine/') || path === '/__test/coverage') return worker.fetch(request, env, ctx); return handlerForPrincipal('owner@nook.test', env.DB, ${JSON.stringify(options.principalGrant)}, env.VAULT_KEY, env)(request, ctx); } }` : 'worker'}; export default ${services ? 'searchWorker(memoryFilesWorker(target))' : 'memoryFilesWorker(target)'};`,
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
    const outboundService = async (request: Request) => {
      const url = new URL(request.url);
      if (
        url.hostname !== 'nook-files-checkpoints.invalid' &&
        url.hostname !== 'nook-vault-checkpoints.invalid'
      ) {
        if (
          options.owner &&
          (url.hostname === 'access.nook.test' ||
            url.hostname.endsWith('.cloudflareaccess.com'))
        )
          return options.owner.outboundService(request);
        if (services) return services.fetch(request);
        return options.owner
          ? options.owner.outboundService(request)
          : new Response('Synthetic external service unavailable', {
              status: 503,
            });
      }
      const label = url.pathname;
      if (label === '/clock') return Response.json(now);
      labels.push(label);
      const accepted = await options.checkpoint?.(label);
      return new Response('synthetic checkpoint', {
        status: accepted === false ? 503 : 200,
      });
    };
    const app = await vaultRuntime({
      directory,
      r2Buckets: ['FILES'],
      outboundService,
    });
    const bindings = {
      ...app.bindings,
      ...options.owner?.bindings,
      ...(options.owner ? { LOCAL_OWNER: '', LOCAL_ORIGIN: '' } : {}),
      ...(services ? { EMBEDDING_MODEL: '@cf/baai/bge-m3' } : {}),
    };
    if (options.owner || services) await app.setBindings(bindings);
    return {
      ...app,
      bindings,
      labels,
      services,
      setTime(value: number) {
        now = value;
      },
      sweep: () =>
        fetch(`${app.origin}/api/__test/files-sweep`, { method: 'POST' }),
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
export type FilesRuntime = Awaited<ReturnType<typeof filesRuntime>>;
