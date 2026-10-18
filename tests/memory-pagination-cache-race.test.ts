import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryClient,
  memoryRows,
  memoryRuntime,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

it('E18/E24: a Load more activation during native refocus preserves cursor recovery', async () => {
  const visible = await visibilityBrowser();
  const app = await memoryRuntime();
  const { page, context } = visible;
  const recoveryGate = deferred();
  const recoveryArrived = deferred();
  let other: Awaited<ReturnType<typeof context.newPage>> | undefined;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    const clock = Date.parse('2026-10-15T12:00:00Z');
    await page.clock.setFixedTime(clock);
    await seedMemories(app, [...typicalMemories, ...manyMemories]);
    await page.goto(`${app.origin}/memory?bucket=work/acme`);
    await expect.poll(() => memoryRows(page).count()).toBe(25);
    const boundary = await memoryRows(page)
      .nth(24)
      .getAttribute('data-memory-row');
    expect(boundary).not.toBeNull();
    other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    const forgotten = await memoryClient(app, '2026-07-28').call('forget', {
      id: boundary,
      expectedVersion: 1,
    });
    expect(forgotten.isError).not.toBe(true);
    await page.clock.setFixedTime(clock + 30_001);
    await page.route('**/api/memories?*', async (route) => {
      const response = await route.fetch();
      if (!new URL(route.request().url()).searchParams.has('cursor')) {
        expect(response.status()).toBe(200);
        recoveryArrived.resolve();
        await recoveryGate.promise;
      }
      await route.fulfill({ response }).catch(() => {});
    });
    // Focus starts the recovery before React can disable the existing button.
    await page.evaluate(() => {
      window.addEventListener(
        'visibilitychange',
        () => {
          if (document.visibilityState !== 'visible') return;
          queueMicrotask(() => {
            const button = [...document.querySelectorAll('button')].find(
              (button) => button.textContent === 'Load more',
            );
            if (!button) throw new Error('Missing real Load more button');
            button.click();
          });
        },
        { once: true },
      );
    });
    await page.bringToFront();
    await recoveryArrived.promise;
    recoveryGate.resolve();
    // The forgotten boundary disappears only once the recovered list renders.
    await expect
      .poll(() => page.locator(`[data-memory-row="${boundary}"]`).count())
      .toBe(0);
    expect(
      await page.getByText('Could not load memories', { exact: true }).count(),
    ).toBe(0);
    const recovered = await memoryRows(page).count();
    expect(recovered).toBeGreaterThanOrEqual(25);
    const next = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/memories' && url.searchParams.has('cursor');
    });
    await page.getByRole('button', { name: 'Load more', exact: true }).click();
    expect((await next).status()).toBe(200);
    await expect.poll(() => memoryRows(page).count()).toBe(recovered + 25);
  } finally {
    recoveryGate.resolve();
    await page.unrouteAll({ behavior: 'ignoreErrors' });
    await other?.close();
    try {
      await observeBrowserPage(page);
    } finally {
      try {
        await visible.close();
      } finally {
        await app.close();
      }
    }
  }
});
