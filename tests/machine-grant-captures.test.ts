import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { bucketCheck, grantPage } from './support/grant-browser.ts';
import {
  grantCaptureMachines,
  largeGrantPaths,
} from './support/grant-captures.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';

const directory = resolve('.local/verification/screenshots');
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const scenarios = [
  'pending',
  'chosen',
  'overlap',
  'only-me',
  'large',
  'none-chosen',
  'buckets-loading',
  'buckets-failed',
  'approving',
  'approved',
  'approve-failed',
  'machines',
] as const;
const matrix = scenarios.flatMap((scenario) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ scenario, theme, size })),
  ),
);
it.each(matrix)(
  'E33: capture $scenario $size.name $theme from the built grant product',
  async ({ scenario, theme, size }) => {
    const gate = deferred();
    const visit = await grantPage(browser, {
      viewport: size,
      colorScheme: theme,
      configure: async (page, app) => {
        const db = await app.mf.getD1Database('DB');
        if (scenario === 'only-me')
          await db.prepare("DELETE FROM buckets WHERE path <> 'me'").run();
        else
          await seedGrantTree(
            app,
            scenario === 'large'
              ? largeGrantPaths
              : ['work/taecontrol/website'],
          );
        const now = Date.now();
        await db
          .prepare('UPDATE authorizations SET requested_at=?, expires_at=?')
          .bind(now - 119_000, now + 480_000)
          .run();
        if (scenario !== 'machines') {
          await page.clock.install({ time: new Date(now) });
          await page.clock.setFixedTime(new Date(now));
        }
        if (scenario === 'buckets-loading')
          await page.route('**/api/buckets', async (route) => {
            await gate.promise;
            await route.continue().catch(() => {});
          });
        if (scenario === 'buckets-failed')
          await page.route('**/api/buckets', (route) => route.abort());
        if (scenario === 'approve-failed')
          await page.route('**/api/authorizations/*/approve', (route) =>
            route.abort(),
          );
        if (scenario === 'approving')
          await page.route('**/api/authorizations/*/approve', async (route) => {
            const response = await route.fetch();
            expect(response.status()).toBe(204);
            await gate.promise;
            await route.fulfill({ response }).catch(() => {});
          });
        if (scenario === 'machines') await grantCaptureMachines(app, page);
      },
    });
    const { page } = visit;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    try {
      if (scenario === 'machines') {
        await page.goto(`${visit.app.origin}/machines`);
        await page.getByText('acme-ci-runner', { exact: true }).waitFor();
      } else {
        await visit.reveal();
        if (scenario === 'buckets-loading')
          await page.getByRole('status', { name: 'Loading buckets' }).waitFor();
        else if (scenario === 'buckets-failed')
          await page
            .getByText("Couldn't load buckets", { exact: true })
            .waitFor();
        else await bucketCheck(page, 'me').waitFor();
        if (
          ['chosen', 'approving', 'approved', 'approve-failed'].includes(
            scenario,
          )
        )
          await bucketCheck(page, 'work').check();
        if (scenario === 'overlap') {
          await bucketCheck(page, 'me').uncheck();
          await bucketCheck(page, 'work/acme').check();
          await bucketCheck(page, 'work').check();
        }
        if (scenario === 'none-chosen') {
          await bucketCheck(page, 'me').uncheck();
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
          await page
            .getByText('Choose at least one bucket.', { exact: true })
            .waitFor();
        }
        if (['approving', 'approved', 'approve-failed'].includes(scenario)) {
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
          if (scenario === 'approved')
            await page
              .getByRole('heading', { name: 'Machine approved' })
              .waitFor();
          if (scenario === 'approving')
            await page.getByRole('button', { name: /Approving…/ }).waitFor();
          if (scenario === 'approve-failed')
            await page
              .getByText("Couldn't reach Nook", { exact: true })
              .waitFor();
        }
      }
      if (!['machines', 'approved', 'approving'].includes(scenario)) {
        const name = page.getByRole('textbox', {
          name: 'Machine name',
          exact: true,
        });
        await name.focus();
        await name.evaluate(
          (input) => input instanceof HTMLInputElement && input.select(),
        );
      }
      await page.evaluate(() => scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(
        await page.getByRole('button', { name: /Scenarios|Reset/ }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
      const filename = `machine-grant-${scenario}-${size.name}-${theme}`;
      await page.screenshot({
        path: resolve(directory, `${filename}.png`),
        animations: 'disabled',
      });
      await page.screenshot({
        path: resolve(directory, `${filename}-full.png`),
        animations: 'disabled',
        fullPage: true,
      });
      if (scenario === 'large') {
        await bucketCheck(
          page,
          'work/acme/platform/services/notifications/push-delivery-retry-scheduler-v2',
        ).scrollIntoViewIfNeeded();
        await page.screenshot({
          path: resolve(directory, `${filename}-deep.png`),
          animations: 'disabled',
          fullPage: true,
        });
      }
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
