import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryId, memoryPage } from './support/memory.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('a pending search debounce preserves a later navigation while Vault loads', async () => {
  const vaultGate = deferred();
  const visit = await memoryPage(browser, {
    configure: async (page) => {
      // Install before Memory registers its timers so cleanup uses this clock.
      await page.clock.install({ time: new Date('2026-10-22T15:00:00Z') });
      await page.route('**/vault-page-*.js', async (route) => {
        await vaultGate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    await page
      .getByRole('heading', { name: 'Release process', exact: true })
      .waitFor();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('memory'))
      .toBe(memoryId(1));
    await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
    await page
      .getByRole('textbox', {
        name: 'Search memories visible in work/acme',
        exact: true,
      })
      .fill('release');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);

    const vaultRequested = page.waitForRequest('**/vault-page-*.js');
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await vaultRequested;
    await expect.poll(() => new URL(page.url()).pathname).toBe('/vault');
    // Memory is still mounted while the real Vault chunk is held.
    expect(
      await page.getByRole('article', { name: 'Memory detail' }).count(),
    ).toBe(1);
    await page.clock.runFor(300);
    vaultGate.resolve();
    await page.clock.resume();
    await page.waitForLoadState('networkidle');

    expect(new URL(page.url()).pathname).toBe('/vault');
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
  } finally {
    vaultGate.resolve();
    await visit.close();
  }
});
