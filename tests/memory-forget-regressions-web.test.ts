import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryFixture, memoryId, memoryRows } from './support/memory.ts';
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

it('E18/E20: an older Check again response preserves a second memory forget progress', async () => {
  const checkGate = deferred();
  const checkArrived = deferred();
  const deleteGate = deferred();
  const deleteArrived = deferred();
  const visit = await forgetPage(browser);
  let reads = 0;
  try {
    const { page } = visit;
    await detail(page).waitFor();
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith(forgottenId)) {
        const response = await route.fetch();
        expect(response.status()).toBe(204);
        await route.abort();
      } else {
        deleteArrived.resolve();
        await deleteGate.promise;
        await route.continue().catch(() => {});
      }
    });
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(404);
      if (++reads === 1) {
        // Lose the authoritative outcome read after the real DELETE committed.
        await route.abort();
        return;
      }
      checkArrived.resolve();
      await checkGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await confirmForget(page);
    const unconfirmed = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await unconfirmed.waitFor();
    await unconfirmed.getByRole('button', { name: 'Check again' }).click();
    await checkArrived.promise;
    await openForget(page, memoryId(2));
    await confirmForget(page);
    await deleteArrived.promise;
    const progress = page.getByText('Forgetting Acme API deployment…', {
      exact: true,
    });
    await progress.waitFor();
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
    checkGate.resolve();
    await (await checked).finished();
    // Let the delivered read and its React update finish while DELETE B is held.
    await rendered(page);
    console.info('check-again-during-forget', {
      reads,
      progress: await progress.count(),
      statuses: await page.getByRole('status').allTextContents(),
    });
    expect(await progress.count()).toBe(1);
    deleteGate.resolve();
    await page
      .getByText('Forgot Acme API deployment', { exact: true })
      .waitFor();
  } finally {
    checkGate.resolve();
    deleteGate.resolve();
    await visit.close();
  }
});
