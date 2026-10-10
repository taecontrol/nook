import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryId,
  memoryPage,
  memoryRows,
  typicalMemories,
} from './support/memory.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
const directory = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const matrix = [
  'work-acme',
  'many',
  'empty-here',
  'first-run',
  'detail',
  'loading',
  'error',
].flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
it.each(matrix)(
  'E32: capture $state $size.name $theme from the real product',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const bucket =
      state === 'first-run'
        ? 'me'
        : state === 'empty-here'
          ? 'personal'
          : 'work/acme';
    const visit = await memoryPage(browser, {
      viewport: size,
      colorScheme: theme,
      seeds:
        state === 'first-run'
          ? []
          : state === 'empty-here'
            ? typicalMemories.filter((m) => m.bucket === 'me')
            : state === 'many'
              ? manyMemories
              : typicalMemories,
      start: `/memory?bucket=${bucket}${state === 'detail' ? `&memory=${memoryId(1)}` : ''}`,
      configure: async (page, app) => {
        if (state === 'loading')
          await page.route('**/api/memories?*', async (route) => {
            const response = await route.fetch();
            await gate.promise;
            await route.fulfill({ response }).catch(() => {});
          });
        if (state === 'error') {
          const db = await app.mf.getD1Database('DB');
          if (
            await db
              .prepare(
                "SELECT name FROM sqlite_master WHERE name='memory_versions'",
              )
              .first()
          )
            await db
              .prepare(
                'ALTER TABLE memory_versions RENAME TO unavailable_versions',
              )
              .run();
        }
      },
    });
    try {
      const { page } = visit;
      await page
        .getByRole('heading', { name: 'Memory', exact: true })
        .waitFor();
      if (state === 'loading')
        await page.getByRole('status', { name: 'Loading memories' }).waitFor();
      else if (state === 'error')
        await page
          .getByText('Could not load memories', { exact: true })
          .waitFor();
      else if (state === 'first-run')
        await page
          .getByText('Agents have not stored any memories yet.', {
            exact: true,
          })
          .waitFor();
      else {
        await memoryRows(page).first().waitFor();
        if (state === 'detail' || size.name === 'desktop')
          await page.getByRole('article', { name: 'Memory detail' }).waitFor();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      await page.screenshot({
        path: resolve(directory, `memory-${state}-${size.name}-${theme}.png`),
        animations: 'disabled',
      });
      if (state === 'detail' && size.name === 'mobile')
        await page.screenshot({
          path: resolve(
            directory,
            `memory-${state}-${size.name}-${theme}-full.png`,
          ),
          fullPage: true,
          animations: 'disabled',
        });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
