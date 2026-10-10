import { setTimeout as delay } from 'node:timers/promises';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  app = await runtime({ bindings: { LOCAL_OWNER: 'synthetic-owner' } });
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  await seedGrantTree(app);
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  await app?.close();
});

it('#21: navigation waits for a fresh 500 ms quiet window after the hover preload even when Home was already networkidle', async () => {
  const { context, page } = await phonePage(browser, 'navigation');
  const gate = deferred();
  try {
    await page.addLocatorHandler(
      page.getByRole('heading', { name: "You're signed in", exact: true }),
      async () => {
        await page.waitForLoadState('networkidle');
        await page.evaluate(() => performance.mark('nook-home-idle'));
        const link = page
          .getByRole('region', { name: 'Platform', exact: true })
          .getByRole('link', { name: /Buckets/ });
        const box = await link.boundingBox();
        if (!box) throw new Error('The Buckets intent target must be visible.');
        const started = page.waitForRequest((request) =>
          request.url().endsWith('/api/buckets'),
        );
        // Start real intent preload before the outer hover resolves.
        await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
        await started;
      },
      { noWaitAfter: true, times: 1 },
    );
    await page.route('**/api/buckets', async (route) => {
      await gate.promise;
      await route.continue();
    });
    const preload = page.waitForRequest((request) =>
      request.url().endsWith('/api/buckets'),
    );
    const release = preload.then(async () => {
      // Keep the real response pending beyond the required quiet window.
      await delay(750);
      gate.resolve();
    });
    await Promise.all([
      measureScreen(page, app.origin, '', 'navigation'),
      release,
    ]);
    const timing = await page.evaluate(() => {
      const idle = performance.getEntriesByName('nook-home-idle')[0];
      const click = performance.getEntriesByName('nook-navigation-start')[0];
      const preload = performance
        .getEntriesByType('resource')
        .find((entry) => new URL(entry.name).pathname === '/api/buckets');
      if (!idle || !click || !(preload instanceof PerformanceResourceTiming))
        throw new Error(
          'The real Home, preload and navigation marks are required.',
        );
      return {
        idle: idle.startTime,
        preload: preload.startTime,
        quiet: click.startTime - preload.responseEnd,
      };
    });
    expect(timing.preload).toBeGreaterThanOrEqual(timing.idle);
    expect(
      timing.quiet,
      'The navigation click must follow preload completion and 500 fresh idle milliseconds.',
    ).toBeGreaterThanOrEqual(500);
    expect(new URL(page.url()).pathname).toBe('/buckets');
    expect(
      await page
        .getByRole('list', { name: 'All buckets', exact: true })
        .locator('[data-path="me"]')
        .isVisible(),
    ).toBe(true);
  } finally {
    gate.resolve();
    await closeBrowserPage(page, context);
  }
});

it('#21: a new request resets the quiet window and its failure permits navigation', async () => {
  const { context, page } = await phonePage(browser, 'navigation');
  let identityReads = 0;
  try {
    await page.route('**/api/whoami', async (route) => {
      if (identityReads++ === 0) return route.continue();
      await delay(800);
      await route.abort('failed');
    });
    const preload = page
      .waitForResponse((response) => response.url().endsWith('/api/buckets'))
      .then((response) => response.finished());
    const failure = preload.then(async () => {
      // A real background read begins inside the post-preload quiet window.
      await delay(200);
      const failed = page.waitForEvent('requestfailed', {
        predicate: (request) => request.url().endsWith('/api/whoami'),
      });
      await page.evaluate(() => {
        void fetch('/api/whoami').catch(() => {});
      });
      await failed;
    });
    await Promise.all([
      measureScreen(page, app.origin, '', 'navigation'),
      failure,
    ]);
    const timing = await page.evaluate(() => {
      const failed = performance
        .getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).pathname === '/api/whoami')
        .at(-1);
      const click = performance.getEntriesByName('nook-navigation-start')[0];
      if (!(failed instanceof PerformanceResourceTiming) || !click)
        throw new Error(
          'A failed background read and a measured click are required.',
        );
      return {
        responseEnd: failed.responseEnd,
        quiet: click.startTime - failed.responseEnd,
      };
    });
    expect(timing.responseEnd).toBeGreaterThan(0);
    expect(timing.quiet).toBeGreaterThanOrEqual(500);
    expect(new URL(page.url()).pathname).toBe('/buckets');
  } finally {
    await closeBrowserPage(page, context);
  }
});

it('#21: an unfinished preload times out before clicking', async () => {
  const { context, page } = await phonePage(browser, 'navigation');
  const gate = deferred();
  try {
    await page.route('**/api/buckets', async (route) => {
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await expect(
      measureScreen(page, app.origin, '', 'navigation'),
    ).rejects.toThrow('Intent preload did not reach 500 ms of network quiet.');
    expect(new URL(page.url()).pathname).toBe('/');
    expect(
      await page.evaluate(
        () => performance.getEntriesByName('nook-navigation-start').length,
      ),
    ).toBe(0);
  } finally {
    gate.resolve();
    await closeBrowserPage(page, context);
  }
});

it('#21: a failed initial navigation preserves the browser error', async () => {
  const { context, page } = await phonePage(browser, 'navigation');
  try {
    await page.route(`${app.origin}/`, (route) => route.abort('failed'));
    await expect(
      measureScreen(page, app.origin, '', 'navigation'),
    ).rejects.toThrow('net::ERR_FAILED');
  } finally {
    await context.close();
  }
});
