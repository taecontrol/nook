import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  closeBrowserPage,
  deepBuckets,
  typicalBuckets,
} from './support/buckets-browser.ts';
import { runtime } from './support/runtime.ts';

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
const states = [
  'typical',
  'fresh',
  'deep-and-long',
  'loading',
  'load-error',
  'create-preview',
  'invalid-path',
  'delete-confirmation',
  'after-create',
];
const matrix = states.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
it.each(matrix)(
  'E17: capture $state $size.name $theme from the built product',
  async ({ state, theme, size }) => {
    const app = await runtime();
    const context = await browser.newContext({
      viewport: size,
      colorScheme: theme,
    });
    const page = await context.newPage();
    let release = () => {};
    try {
      await app.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
      });
      const db = await app.mf.getD1Database('DB');
      const data =
        state === 'fresh'
          ? [{ path: 'me', createdAt: '2026-10-04T08:00:00.000Z' }]
          : state === 'deep-and-long'
            ? deepBuckets
            : typicalBuckets;
      await db.batch(
        data.map((bucket) =>
          db
            .prepare(
              'INSERT INTO buckets(path, created_at) VALUES(?, ?) ON CONFLICT(path) DO UPDATE SET created_at=excluded.created_at',
            )
            .bind(bucket.path, bucket.createdAt),
        ),
      );
      if (state === 'loading') {
        const waiting = new Promise<void>((accept) => {
          release = accept;
        });
        await page.route('**/api/buckets', async (route) => {
          await waiting;
          await route.abort().catch(() => {});
        });
      }
      if (state === 'load-error')
        await page.route('**/api/buckets', (route) =>
          route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
        );
      await page.goto(`${app.origin}/buckets`);
      await page
        .getByRole('heading', { name: 'Buckets', exact: true })
        .waitFor();
      if (state === 'loading')
        await page.getByRole('status', { name: 'Loading buckets' }).waitFor();
      else if (state === 'load-error')
        await page
          .getByText("Couldn't load buckets", { exact: true })
          .waitFor();
      else await page.locator('[data-path="me"]').waitFor();
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      if (state === 'create-preview') {
        await field.fill('clients/acme/website');
        await page.locator('[data-path="clients/acme/website"]').waitFor();
      }
      if (state === 'invalid-path') {
        await field.fill('Work/Acme');
        await page
          .getByText('Use lowercase letters:', { exact: false })
          .waitFor();
      }
      if (state === 'delete-confirmation') {
        await page
          .getByRole('button', {
            name: 'Actions for work/taecontrol/nook',
            exact: true,
          })
          .click();
        await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
        await page.getByRole('alertdialog').waitFor();
      }
      if (state === 'after-create') {
        await field.fill('work/acme');
        const response = page.waitForResponse(
          (response) =>
            response.request().method() === 'POST' &&
            response.url().endsWith('/api/buckets'),
        );
        await field.press('Enter');
        expect((await response).status()).toBe(200);
        await page
          .locator('li[data-bucket="work"] ul [data-path="work/acme"]')
          .waitFor();
        await expect.poll(() => field.isEnabled()).toBe(true);
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      if (state === 'deep-and-long') {
        const names = await page
          .locator('[data-path] > div span')
          .allTextContents();
        expect(names.join(' ')).toContain('municipal-water-authority-ops-mx');
        expect(names.join(' ')).toContain('terraform-state-backups');
      }
      await page.screenshot({
        path: resolve(directory, `buckets-${state}-${size.name}-${theme}.png`),
        animations: 'disabled',
      });
    } finally {
      release();
      await closeBrowserPage(page, context);
      await app.close();
    }
  },
);
