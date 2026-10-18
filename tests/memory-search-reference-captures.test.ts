import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { memoryId } from './fixtures/memories.ts';
import {
  deepBucket,
  extremeMemories,
  searchMemories,
} from './fixtures/search-corpus.ts';
import { deferred } from './support/machines.ts';
import { memoryRows } from './support/memory.ts';
import { searchPage } from './support/search.ts';

const directory = resolve('.local/verification/screenshots');
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
const scenarios = [
  'idle',
  'cross-language',
  'exact-keyword',
  'no-results',
  'loading',
  'error',
  'meaning-unavailable',
  'extremes',
  'only-this-bucket',
  'result-open',
  'fresh-owner',
] as const;
const matrix = scenarios.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'phone', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
it.each(matrix)(
  'E21: capture $state $size.name $theme from the real search endpoint',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const seeds =
      state === 'fresh-owner'
        ? []
        : state === 'extremes'
          ? extremeMemories
          : searchMemories;
    const bucket =
      state === 'extremes'
        ? deepBucket
        : state === 'fresh-owner'
          ? 'me'
          : 'work/acme';
    const visit = await searchPage(browser, {
      seeds,
      viewport: size,
      colorScheme: theme,
      start: `/memory?bucket=${encodeURIComponent(bucket)}${size.name === 'desktop' && state !== 'fresh-owner' && state !== 'extremes' ? `&memory=${memoryId(21)}` : ''}`,
    });
    const errors: string[] = [];
    visit.page.on('pageerror', (error) => errors.push(error.name));
    try {
      const { page, app } = visit;
      const field = page.getByRole('textbox', {
        name: /Search memories visible/,
      });
      await field.waitFor();
      if (seeds.length) await memoryRows(page).first().waitFor();
      const search = async (q: string) => {
        await field.fill(q);
        await field.press('Enter');
      };
      if (state === 'no-results') {
        // An empty/not-yet-visible meaning index is a legitimate derived state.
        app.services.clear();
        await search('kubernetes helm chart');
        await page.getByText('No memories found', { exact: true }).waitFor();
      } else if (state === 'meaning-unavailable') {
        app.services.failEmbedding = true;
        await search('pnpm verify');
        await page.getByRole('alert').waitFor();
        await page.locator('[data-search-result]').first().waitFor();
      } else if (state === 'error') {
        await (await app.mf.getD1Database('DB'))
          .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
          .run();
        await search('how do we deploy');
        await page
          .getByText('Could not search memories', { exact: true })
          .waitFor();
      } else if (state !== 'idle' && state !== 'fresh-owner') {
        if (state === 'only-this-bucket')
          await page
            .getByRole('button', { name: 'Only this bucket', exact: true })
            .click();
        await search(
          state === 'exact-keyword'
            ? 'pnpm verify'
            : state === 'extremes'
              ? 'publicar'
              : 'how do we deploy',
        );
        await page.locator('[data-search-result]').first().waitFor();
        if (state === 'loading') {
          await page.route('**/api/memories/search?*', async (route) => {
            const response = await route.fetch();
            await gate.promise;
            await route.fulfill({ response }).catch(() => {});
          });
          await search('pnpm verify');
          await page.getByText('Searching…', { exact: true }).waitFor();
        }
        if (state === 'result-open') {
          await page.locator(`[data-search-result="${memoryId(20)}"]`).click();
          await page
            .getByRole('heading', { name: 'Proceso de release', exact: true })
            .waitFor();
        }
      } else if (state === 'fresh-owner') {
        await page
          .getByText('Agents have not stored any memories yet.', {
            exact: true,
          })
          .waitFor();
        expect(await field.isDisabled()).toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(errors).toEqual([]);
      expect(
        await page.getByText('Prototype scenario', { exact: true }).count(),
      ).toBe(0);
      await page.screenshot({
        path: resolve(
          directory,
          `memory-search-${state}-${size.name}-${theme}.png`,
        ),
        animations: 'disabled',
      });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
