import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryFixture, memoryRows } from './support/memory.ts';
import {
  confirmForget,
  forgetPage,
  forgottenId,
  openForget,
} from './support/memory-forget.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

const detail = (page: Page) =>
  page.getByRole('article', { name: 'Memory detail' });
const rendered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

it.each([false, true])(
  'E20/E21: late failure of the only memory forget preserves a later navigation to Vault; held route=%s',
  async (holdRoute) => {
    const vaultGate = deferred();
    const vaultArrived = deferred();
    const gate = deferred();
    const arrived = deferred();
    const errors: string[] = [];
    const visit = await forgetPage(browser, {
      seeds: [
        memoryFixture(1, {
          bucket: 'work/acme/api',
          content: '# Release process\nOnly memory.',
        }),
      ],
      start: `/memory?bucket=work/acme/api&scope=bucket&memory=${forgottenId}`,
      configure: async (page, app) => {
        if (holdRoute)
          await page.route('**/vault-page-*.js', async (route) => {
            vaultArrived.resolve();
            await vaultGate.promise;
            await route.continue().catch(() => {});
          });
        page.on('pageerror', (error) => errors.push(error.message));
        await (await app.mf.getD1Database('DB'))
          .prepare(
            "CREATE TRIGGER synthetic_forget_abort BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
          )
          .run();
        await page.route(
          '**/api/memories/*?expectedVersion=*',
          async (route) => {
            const response = await route.fetch();
            expect(response.status()).toBe(503);
            arrived.resolve();
            await gate.promise;
            await route.fulfill({ response }).catch(() => {});
          },
        );
      },
    });
    try {
      const { page } = visit;
      await detail(page).waitFor();
      await openForget(page);
      await confirmForget(page);
      await arrived.promise;
      await page
        .getByText('Forgetting Release process…', { exact: true })
        .waitFor();
      expect(await memoryRows(page).count()).toBe(0);
      console.info('before-leaving-memory', { url: page.url() });
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await expect.poll(() => new URL(page.url()).pathname).toBe('/vault');
      if (holdRoute) await vaultArrived.promise;
      const recovery = page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
      );
      gate.resolve();
      const response = await recovery;
      expect(response.status()).toBe(200);
      await response.finished();
      await rendered(page);
      vaultGate.resolve();
      await page.waitForLoadState('networkidle');
      console.info('late-forget-failure', { url: page.url(), errors });
      expect(new URL(page.url()).pathname).toBe('/vault');
    } finally {
      vaultGate.resolve();
      gate.resolve();
      await visit.close();
    }
  },
);
