import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  historyPage,
  type ScenarioName,
  scenarios,
} from './support/memory-history.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
const directory = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
const matrix = (Object.keys(scenarios) as ScenarioName[]).flatMap((scenario) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { width: 1440, height: 900, name: 'desktop' },
      { width: 390, height: 844, name: 'phone' },
    ].map((size) => ({ scenario, theme, size })),
  ),
);
it.each(matrix)(
  'E29: capture $scenario $size.name $theme against the chosen Sheet',
  async ({ scenario, theme, size }) => {
    const gate = deferred();
    const visit = await historyPage(browser, {
      scenario,
      viewport: size,
      colorScheme: theme,
      configure: async (page) => {
        if (scenario === 'history-loading')
          await page.route('**/api/memories/*/versions*', async (route) => {
            const response = await route.fetch();
            await gate.promise;
            await route.fulfill({ response }).catch(() => {});
          });
        if (scenario === 'history-error')
          await page.route('**/api/memories/*/versions*', (route) =>
            route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"_tag":"ServiceUnavailable"}',
            }),
          );
      },
    });
    try {
      const { page } = visit;
      const button = page.getByRole('button', { name: /History.*versions?/ });
      await button.waitFor();
      const capture = async (state: string) => {
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(size.width);
        await page.screenshot({
          path: resolve(
            directory,
            `memory-history-${scenario}--${state}--${size.name}-${theme}.png`,
          ),
          animations: 'disabled',
        });
      };
      await capture('reading');
      await button.click();
      const sheet = page.getByRole('dialog');
      if (scenario === 'history-loading')
        await sheet.getByRole('status', { name: 'Loading history' }).waitFor();
      else if (scenario === 'history-error')
        await sheet.getByRole('button', { name: 'Retry history' }).waitFor();
      else await page.locator('[data-version-row]').last().waitFor();
      await capture('list');
      const version =
        scenario === 'many' ? 17 : scenario === 'never-updated' ? 1 : 2;
      if (scenario.startsWith('history-')) {
        await page.goto(page.url() + `&version=${version}`);
        if (scenario === 'history-loading')
          await sheet
            .getByRole('status', { name: 'Loading version' })
            .waitFor();
        else
          await sheet.getByRole('button', { name: 'Retry history' }).waitFor();
      } else {
        await page.locator(`[data-version-row="${version}"]`).click();
        await sheet
          .getByRole('heading', { name: `Version ${version} of`, exact: false })
          .waitFor();
      }
      await capture(`v${version}`);
      if (!scenario.startsWith('history-') && version > 1) {
        await sheet.getByRole('button', { name: 'Show changes' }).click();
        await page.locator('[data-memory-diff]').waitFor();
        await capture(`v${version}-changes`);
        if (scenario === 'typical') {
          await sheet.getByRole('button', { name: 'Newer version' }).click();
          await sheet
            .getByText('The content is the same as in version 2.')
            .waitFor();
          await capture('v3-changes');
          await sheet.getByRole('button', { name: 'Newer version' }).click();
          await page.locator('[data-memory-diff]').waitFor();
          await capture('v4-changes');
        }
        if (scenario === 'long') {
          await sheet.getByRole('button', { name: 'Newer version' }).click();
          await sheet
            .getByRole('heading', { name: 'Version 3 of 3' })
            .waitFor();
          await capture('v3-changes');
        }
      }
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
  30_000,
);
