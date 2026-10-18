import { createHash } from 'node:crypto';
import type { QueryClient } from '@tanstack/react-query';
import type { Browser, Page } from 'playwright';
import { expect } from 'vitest';
import { memoryClient, memoryId, memoryPage } from './memory.ts';
import type { TestRuntime } from './runtime.ts';

export const forgottenId = memoryId(1);
export const uniqueTerm = 'forgettableuniqueword';
export const changedForget = (current: number, expected: number) =>
  `This memory changed: it is now version ${current}, not ${expected}. Get it again before forgetting.`;
export async function versionThree(app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  const original = await db
    .prepare(
      'SELECT content FROM memory_versions WHERE memory_id=? AND version=1',
    )
    .bind(forgottenId)
    .first<{ content: string }>();
  if (!original) throw new Error('The forget fixture needs its first version.');
  for (const version of [2, 3]) {
    const content = `${original.content}\n\nVersion ${version}: ${uniqueTerm}`;
    await db.batch([
      db
        .prepare(
          'INSERT INTO memory_versions(memory_id,version,content,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at) SELECT memory_id,?, ?,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at FROM memory_versions WHERE memory_id=? AND version=1',
        )
        .bind(version, content, forgottenId),
      db
        .prepare(
          'UPDATE memories SET current_version=?,content_hash=? WHERE id=?',
        )
        .bind(
          version,
          createHash('sha256').update(content).digest('hex'),
          forgottenId,
        ),
    ]);
  }
}
export async function forgetSnapshot(app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  const exists = await db
    .prepare(
      "SELECT name FROM sqlite_schema WHERE name='memory_vector_removals'",
    )
    .first();
  return {
    heads: (await db.prepare('SELECT * FROM memories ORDER BY id').all())
      .results,
    versions: (
      await db
        .prepare('SELECT * FROM memory_versions ORDER BY memory_id,version')
        .all()
    ).results,
    fts: (
      await db
        .prepare(
          'SELECT id,hex(block) AS block FROM memories_fts_data ORDER BY id',
        )
        .all()
    ).results,
    removals: exists
      ? (
          await db
            .prepare('SELECT * FROM memory_vector_removals ORDER BY id')
            .all()
        ).results
      : [],
  };
}
export async function removalRows(app: TestRuntime) {
  return (
    await (
      await app.mf.getD1Database('DB')
    )
      .prepare('SELECT * FROM memory_vector_removals ORDER BY forgotten_at,id')
      .all<{ id: string; forgotten_at: string }>()
  ).results;
}
export async function ftsIntegrity(app: TestRuntime) {
  expect(
    await (await app.mf.getD1Database('DB'))
      .prepare(
        "INSERT INTO memories_fts(memories_fts,rank) VALUES ('integrity-check',1)",
      )
      .run(),
  ).toMatchObject({ success: true });
}
export async function forgetMemory(
  app: TestRuntime,
  id = forgottenId,
  expectedVersion = 1,
) {
  const result = await memoryClient(app, '2026-07-28').call('forget', {
    id,
    expectedVersion,
  });
  expect(result.isError, 'The real forget tool succeeds').not.toBe(true);
  expect(result.structuredContent).toMatchObject({
    id,
    version: expectedVersion,
  });
  return result;
}
export function forgetPage(
  browser: Browser,
  options: Parameters<typeof memoryPage>[1] = {},
) {
  return memoryPage(browser, {
    ...options,
    start: options.start ?? `/memory?bucket=work/acme&memory=${forgottenId}`,
    configure: async (page, app) => {
      await versionThree(app);
      await options.configure?.(page, app);
    },
  });
}
export const forgetDialog = (page: Page) => page.getByRole('alertdialog');
export function memoryQueries(page: Page) {
  return page.evaluateHandle(() => {
    const element = document.querySelector('#root > *');
    const key = Object.keys(element ?? {}).find((entry) =>
      entry.startsWith('__reactFiber$'),
    );
    type Fiber = {
      return?: Fiber;
      memoizedProps?: { client?: QueryClient };
    };
    let fiber = key
      ? (element as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (client?.getMutationCache) return client;
      fiber = fiber.return;
    }
    throw new Error('The mounted app has no QueryClient.');
  });
}
export async function openForget(page: Page, id?: string) {
  const trigger = id
    ? page.locator(`[data-memory-actions="${id}"]`)
    : page.getByRole('button', { name: 'More actions', exact: true });
  await trigger.click();
  await page
    .getByRole('menuitem', { name: 'Forget memory…', exact: true })
    .click();
  await forgetDialog(page).waitFor();
}
export async function confirmForget(page: Page) {
  await forgetDialog(page)
    .getByRole('button', { name: 'Forget memory', exact: true })
    .click();
}
