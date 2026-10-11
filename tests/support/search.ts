import { cp, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import type { Browser } from 'playwright';
import { expect } from 'vitest';
import {
  embeddingRecordings,
  SearchStandIns,
} from '../../scripts/search-stand-ins.ts';
import { closeBrowserPage } from './buckets-browser.ts';
import { seedGrantTree } from './grants.ts';
import { type MemoryFixture, memoryBuckets, seedMemories } from './memory.ts';
import { runtime, testBuild } from './runtime.ts';

export type SearchHit = {
  id: string;
  bucket: string;
  title: string;
  tags: string[];
  snippet: string;
  highlights?: [number, number][];
  match: 'keyword' | 'meaning' | 'both';
  createdAt?: string;
  provenance?: unknown;
};
export type SearchResponse = {
  results: SearchHit[];
  meaning: 'available' | 'unavailable';
};
export async function searchRuntime() {
  const services = new SearchStandIns(await embeddingRecordings());
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'search-runtime-'));
  try {
    await cp(resolve(testBuild, 'assets'), resolve(directory, 'assets'), {
      recursive: true,
    });
    await build({
      stdin: {
        contents: `import worker from ${JSON.stringify(resolve(testBuild, 'worker.js'))}; import { searchWorker } from ${JSON.stringify(resolve('tests/support/search-worker.ts'))}; export default searchWorker(worker);`,
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
      outboundService: (request) => services.fetch(request),
    });
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
      EMBEDDING_MODEL: '@cf/baai/bge-m3',
    });
    await seedGrantTree(app, [...memoryBuckets, 'work/other']);
    return {
      ...app,
      services,
      async scheduled() {
        await (await app.mf.getWorker()).scheduled({
          cron: '*/5 * * * *',
          scheduledTime: new Date(),
        });
      },
      async close() {
        try {
          await app.close();
          expect(
            services.missing.size,
            'Unrecorded embeddings must fail acceptance',
          ).toBe(0);
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
export type SearchRuntime = Awaited<ReturnType<typeof searchRuntime>>;
export async function indexMemories(
  app: SearchRuntime,
  seeds: MemoryFixture[],
) {
  await seedMemories(app, seeds);
  await app.scheduled();
  app.services.advance();
  expect(
    app.services.missing.size,
    'All embeddings must be recorded, never synthesized in acceptance',
  ).toBe(0);
  app.services.resetCalls();
}
export async function httpSearch(
  app: SearchRuntime,
  q: string,
  bucket = 'work/acme',
  scope = 'inherited',
) {
  const response = await fetch(
    `${app.origin}/api/memories/search?${new URLSearchParams({ bucket, scope, q })}`,
  );
  expect(
    response.status,
    'The genuine owner search endpoint is available',
  ).toBe(200);
  return (await response.json()) as SearchResponse;
}
export async function searchPage(
  browser: Browser,
  options: {
    seeds: MemoryFixture[];
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (app: SearchRuntime) => Promise<void>;
  },
) {
  const app = await searchRuntime();
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const close = async () => {
    try {
      await closeBrowserPage(page, context);
    } finally {
      await app.close();
    }
  };
  try {
    const paths = [...new Set(options.seeds.map((m) => m.bucket))];
    for (const path of paths)
      await seedGrantTree(
        app,
        path.split('/').map((_, i, p) => p.slice(0, i + 1).join('/')),
      );
    await indexMemories(app, options.seeds);
    await options.configure?.(app);
    await page.goto(app.origin + (options.start ?? '/memory?bucket=work/acme'));
    return { page, app, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
