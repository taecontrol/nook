import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { setMark, stripe } from './support/owner-approval.ts';
import { seedSecrets, vaultRuntime } from './support/vault.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeAll(async () => {
  app = await vaultRuntime();
  await seedGrantTree(app);
  await seedSecrets(app);
  await setMark(app);
  await setMark(app, 'me');
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  try {
    await closeBrowser();
  } finally {
    await app.close();
  }
});

it('Vault timing waits for Ask first switches and inherited coverage after secrets and counts have rendered', async () => {
  const { context, page } = await phonePage(browser, 'vault');
  const gate = deferred();
  const started = deferred();
  await page.route('**/api/ask-first', async (route) => {
    const response = await route.fetch();
    started.resolve();
    await gate.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  const measurement = measureScreen(page, app.origin, '', 'vault');
  // Observe a rejection immediately even if an earlier assertion fails.
  void measurement.catch(() => {});
  try {
    await started.promise;
    await page.locator(`[data-secret="${stripe}"]`).waitFor();
    await page
      .getByRole('navigation', { name: 'Buckets', exact: true })
      .locator('[data-path="work/acme"]')
      .getByText('4 secrets', { exact: true })
      .waitFor();
    // Let the existing double-animation-frame readiness marker run, if it can.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
        ),
    );
    expect(await page.getByRole('switch').count()).toBe(0);
    expect(
      await page.evaluate(
        () => performance.getEntriesByName('nook-first-screen').length,
      ),
      'Vault is not ready while Ask first controls are skeletons',
    ).toBe(0);
    gate.resolve();
    expect(await measurement).toBeGreaterThan(0);
    const switches = page.getByRole('switch');
    expect(await switches.count()).toBe(
      (await page.locator('[data-secret]').count()) + 1,
    );
    for (const control of await switches.all()) {
      expect(await control.getAttribute('aria-checked')).toBe('true');
      expect(await control.isDisabled()).toBe(true);
    }
    expect(
      await page.locator(`[data-secret="${stripe}"]`).innerText(),
    ).toContain('Ask first, from work');
    expect(
      await page
        .getByText(
          'On because work asks first. To turn it off, open that bucket.',
          { exact: true },
        )
        .count(),
    ).toBe(1);
  } finally {
    gate.resolve();
    await measurement.catch(() => {});
    await context.close();
  }
});
