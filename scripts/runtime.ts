import { resolve } from 'node:path';
import { Miniflare } from 'miniflare';
import { unstable_readConfig } from 'wrangler';

export function runtimeOptions(options: {
  port: number;
  directory: string;
  configPath?: string;
  bindings?: Record<string, string>;
  syntheticOwner?: boolean;
  coverage?: boolean;
  outboundService?: (request: Request) => Promise<Response>;
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
    bindings,
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

export async function startRuntime(
  options: Parameters<typeof runtimeOptions>[0],
) {
  const settings = runtimeOptions(options);
  const runtime = new Miniflare(settings);
  try {
    await runtime.ready;
    return { runtime, settings };
  } catch (error) {
    await runtime.dispose();
    throw error;
  }
}
