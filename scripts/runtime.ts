import { resolve } from 'node:path';
import { build } from 'esbuild';
import { Miniflare } from 'miniflare';
import { unstable_readConfig } from 'wrangler';
import { applyMigrations } from './lib/migrations.ts';
import { embeddingRecordings, SearchStandIns } from './search-stand-ins.ts';

export function runtimeOptions(options: {
  port: number;
  directory: string;
  configPath?: string;
  bindings?: Record<string, string>;
  syntheticOwner?: boolean;
  strictEmbeddings?: boolean;
  coverage?: boolean;
  outboundService?: (request: Request) => Promise<Response>;
  r2Buckets?: string[];
}) {
  const config = unstable_readConfig({
    config: options.configPath ?? 'wrangler.jsonc',
  });
  const rules = config.assets?.run_worker_first;
  if (!Array.isArray(rules))
    throw new Error('Explicit asset routing required.');
  const bindings = options.syntheticOwner
    ? {
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: `http://127.0.0.1:${options.port}`,
        ...options.bindings,
      }
    : options.bindings;
  return {
    host: '127.0.0.1',
    port: options.port,
    modules: true,
    scriptPath: resolve(options.directory, 'worker.js'),
    compatibilityDate: config.compatibility_date,
    compatibilityFlags: config.compatibility_flags,
    cf: false as false | Record<string, unknown>,
    bindings,
    d1Databases: (config.d1_databases ?? []).map(
      (database: { binding: string }) => database.binding,
    ),
    d1Persist: false,
    r2Buckets:
      options.r2Buckets ??
      (config.r2_buckets ?? []).map(
        (bucket: { binding: string }) => bucket.binding,
      ),
    r2Persist: false,
    outboundService: options.outboundService,
    assets: {
      directory: resolve(options.directory, 'assets'),
      assetConfig: { not_found_handling: config.assets?.not_found_handling },
      routerConfig: {
        has_user_worker: true,
        static_routing: {
          user_worker: [
            ...rules.filter((rule) => !rule.startsWith('!')),
            ...(options.coverage ? ['/__test/coverage'] : []),
          ],
          asset_worker: rules
            .filter((rule) => rule.startsWith('!'))
            .map((rule) => rule.slice(1)),
        },
      },
    },
  };
}

async function localSettings(
  settings: ReturnType<typeof runtimeOptions>,
  strict: boolean,
) {
  const services = new SearchStandIns(await embeddingRecordings(), strict);
  services.autoAdvance = true;
  const bundle = await build({
    stdin: {
      contents: `import worker from ${JSON.stringify(settings.scriptPath)}; import { localSearchWorker } from ${JSON.stringify(resolve('scripts/local-search-worker.ts'))}; export default localSearchWorker(worker);`,
      resolveDir: process.cwd(),
    },
    write: false,
    bundle: true,
    format: 'esm',
    platform: 'neutral',
    conditions: ['workerd', 'worker', 'browser'],
    external: ['node:*', 'cloudflare:*'],
    target: 'es2023',
  });
  const { scriptPath: _scriptPath, ...rest } = settings;
  return {
    ...rest,
    script: bundle.outputFiles[0].text,
    bindings: {
      EMBEDDING_MODEL: '@cf/baai/bge-m3',
      ...settings.bindings,
    } as Record<string, string>,
    serviceBindings: {
      NOOK_LOCAL_SEARCH: (request: Request) => services.fetch(request),
    },
  };
}

export async function startRuntime(
  options: Parameters<typeof runtimeOptions>[0],
) {
  const configured = runtimeOptions(options);
  const settings = options.syntheticOwner
    ? await localSettings(configured, options.strictEmbeddings ?? false)
    : configured;
  const runtime = new Miniflare(settings);
  try {
    await runtime.ready;
    for (const binding of settings.d1Databases)
      await applyMigrations(await runtime.getD1Database(binding));
    return { runtime, settings };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
