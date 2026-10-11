import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { expect } from 'vitest';
import {
  type MemoryFixture,
  memoryBuckets,
  typicalMemories,
} from '../fixtures/memories.ts';
import { closeBrowserPage } from './buckets-browser.ts';
import { seedGrantTree } from './grants.ts';
import { type McpVersion, mcpDriver } from './mcp.ts';
import { runtime, type TestRuntime } from './runtime.ts';

export * from '../fixtures/memories.ts';

export async function seedMemories(app: TestRuntime, seeds = typicalMemories) {
  if (seeds.length === 0) return;
  const db = await app.mf.getD1Database('DB');
  await db.batch(
    seeds.flatMap((m) => [
      db
        .prepare(
          'INSERT INTO memories(id,bucket,current_version,content_hash,created_at,updated_at) VALUES (?,?,1,?,?,?)',
        )
        .bind(
          m.id,
          m.bucket,
          createHash('sha256').update(m.content).digest('hex'),
          m.createdAt,
          m.createdAt,
        ),
      db
        .prepare(
          'INSERT INTO memory_versions(memory_id,version,content,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at) VALUES (?,1,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          m.id,
          m.content,
          JSON.stringify(m.tags),
          m.client.name,
          m.client.version,
          m.principal.kind,
          m.principal.kind === 'machine' ? m.principal.id : null,
          m.principal.kind === 'machine' ? m.principal.name : null,
          m.workingDirectory,
          m.createdAt,
        ),
    ]),
  );
}
export async function memoryRuntime(
  options: Parameters<typeof runtime>[0] = {},
) {
  const app = await runtime(options);
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  await seedGrantTree(app, memoryBuckets);
  return app;
}
export async function seedMemoryMachine(
  app: TestRuntime,
  grant: unknown = ['work'],
) {
  const token = `nook_${randomBytes(32).toString('base64url')}`;
  const id = randomUUID();
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'INSERT INTO machine_tokens(token_hash,machine_name,grant_json,created_at,id) VALUES (?,?,?,?,?)',
    )
    .bind(
      createHash('sha256').update(token).digest('hex'),
      'luis-mbp',
      JSON.stringify(grant),
      Date.now(),
      id,
    )
    .run();
  return { token, id };
}
export function memoryClient(
  app: TestRuntime,
  version: McpVersion,
  options: {
    machine?: boolean;
    headers?: HeadersInit;
    clientInfo?: unknown;
    removeClientInfo?: boolean;
  } = {},
) {
  return mcpDriver(app.origin, version, options.headers, async (request) => {
    const url = new URL(request.url);
    if (options.machine) url.pathname = '/api/machine/mcp';
    const body = JSON.parse(await request.text());
    if (options.removeClientInfo && body.params?._meta)
      delete body.params._meta['io.modelcontextprotocol/clientInfo'];
    if (options.clientInfo !== undefined) {
      body.params ??= {};
      body.params._meta ??= {};
      body.params._meta['io.modelcontextprotocol/clientInfo'] =
        options.clientInfo;
    }
    return fetch(
      new Request(url, {
        method: 'POST',
        headers: request.headers,
        body: JSON.stringify(body),
      }),
    );
  });
}
export async function memoryCounts(app: TestRuntime) {
  return (await (
    await app.mf.getD1Database('DB')
  )
    .prepare(
      'SELECT (SELECT count(*) FROM memories) AS memories, (SELECT count(*) FROM memory_versions) AS versions',
    )
    .first()) as { memories: number; versions: number };
}
export async function memoryPage(
  browser: Browser,
  options: {
    seeds?: MemoryFixture[];
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  const app = await memoryRuntime();
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
    await seedMemories(app, options.seeds);
    await options.configure?.(page, app);
    await page.goto(app.origin + (options.start ?? '/memory?bucket=work/acme'));
    return { page, app, context, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export const memoryRows = (page: Page) => page.locator('[data-memory-row]');
export async function listMemoryPage(
  app: TestRuntime,
  query = 'bucket=work/acme',
  headers: HeadersInit = {},
) {
  const response = await fetch(`${app.origin}/api/memories?${query}`, {
    headers,
  });
  expect(response.status, 'The owner memory read API is available').toBe(200);
  return (await response.json()) as {
    memories: {
      id: string;
      bucket: string;
      title: string;
      tags: string[];
      createdAt: string;
      provenance: unknown;
    }[];
    next: string | null;
  };
}
