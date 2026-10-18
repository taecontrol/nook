import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryId, memoryRuntime, seedMemories } from './support/memory.ts';
import {
  confirmForget,
  forgottenId,
  openForget,
  versionThree,
} from './support/memory-forget.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

it('#62: history mounted during a forget waits for settlement, including native refocus', async () => {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  const gate = deferred();
  const arrived = deferred();
  let reads = 0;
  try {
    page.setDefaultTimeout(5000);
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedMemories(app);
    await versionThree(app);
    await page.goto(
      `${app.origin}/memory?bucket=work/acme&memory=${forgottenId}`,
    );
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await page.route('**/api/memories/*/versions**', (route) => {
      reads++;
      return route.continue();
    });
    await confirmForget(page);
    await arrived.promise;
    await page
      .getByRole('article', { name: 'Memory detail' })
      .getByRole('heading', { name: 'Acme API deployment', exact: true })
      .waitFor();
    await page.getByRole('button', { name: /History.*version/ }).click();
    await page
      .getByRole('dialog')
      .getByRole('heading', { name: 'History', exact: true })
      .waitFor();
    const background = await context.newPage();
    await background.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('visible');
    expect(
      reads,
      'No history reads may start while a Memory write owns the cache',
    ).toBe(0);
    gate.resolve();
    await page.locator('[data-version-row="1"]').waitFor();
    expect(reads).toBeGreaterThan(0);
    expect(new URL(page.url()).searchParams.get('memory')).toBe(memoryId(2));
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});

it('#62: forget detail cannot refocus between submission and the pending render', async () => {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  const gate = deferred();
  const arrived = deferred();
  let reads = 0;
  try {
    page.setDefaultTimeout(5000);
    await page.setViewportSize({ width: 1440, height: 900 });
    const clock = Date.parse('2026-10-18T12:00:00Z');
    await page.clock.setFixedTime(clock);
    await seedMemories(app);
    await versionThree(app);
    await page.goto(
      `${app.origin}/memory?bucket=work/acme&q=forgettableuniqueword`,
    );
    await openForget(page, forgottenId);
    await page
      .getByRole('alertdialog')
      .getByText('You are forgetting version 3', { exact: false })
      .waitFor();
    await page.route(`**/api/memories/${forgottenId}`, (route) => {
      reads++;
      return route.continue();
    });
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route
        .fulfill({ status: 403, body: 'Access denied' })
        .catch(() => {});
    });
    const background = await context.newPage();
    await background.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    await page.clock.setFixedTime(clock + 30_001);
    await page.evaluate(() => {
      window.addEventListener(
        'visibilitychange',
        () => {
          const button = document.querySelector<HTMLButtonElement>(
            '[role="alertdialog"] button:last-child',
          );
          if (!button || button.textContent !== 'Forget memory')
            throw new Error('Missing forget confirmation');
          button.click();
        },
        { once: true, capture: true },
      );
    });
    await page.bringToFront();
    await arrived.promise;
    await page
      .getByText('Forgetting Release process…', { exact: true })
      .waitFor();
    expect(
      reads,
      'The gate must close synchronously before React renders pending',
    ).toBe(0);
    gate.resolve();
    await page.getByText('Not forgotten', { exact: true }).waitFor();
    await expect.poll(() => reads).toBeGreaterThan(0);
  } finally {
    gate.resolve();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});
