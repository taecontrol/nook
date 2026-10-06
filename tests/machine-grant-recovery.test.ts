import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { bucketCheck, grantPage, selectDeep } from './support/grant-browser.ts';
import { deferred } from './support/machines.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it('E24/E33: the mobile transition preserves name focus and keeps the approval heading and bucket choices in view', async () => {
  const { page, reveal, close } = await grantPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    await page.waitForLoadState('networkidle');
    await reveal();
    await expect
      .poll(() => page.evaluate(() => document.activeElement?.id))
      .toBe('machine-name');
    expect(await page.evaluate(() => scrollY)).toBe(0);
    for (const locator of [
      page.getByRole('heading', { name: 'Approve this machine?' }),
      page.getByRole('heading', { name: 'Bucket access', exact: true }),
      page.locator('[data-grant-path="me"] > div'),
    ]) {
      expect(
        await locator.evaluate((node) => {
          const box = node.getBoundingClientRect();
          return (
            box.width > 0 &&
            box.height > 0 &&
            box.top >= 0 &&
            box.bottom <= innerHeight &&
            box.left >= 0 &&
            box.right <= innerWidth
          );
        }),
        'Approval context remains visible after the natural transition',
      ).toBe(true);
    }
  } finally {
    await close();
  }
});
it('E29: a background refresh of cached buckets blocks limited approval and Enter, while All and Deny remain available', async () => {
  const held = deferred();
  let loads = 0;
  const { page, reveal, approvals, close } = await grantPage(browser, {
    configure: async (page) => {
      await page.route('**/api/buckets', async (route) => {
        loads++;
        if (loads > 1) await held.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    await reveal();
    await bucketCheck(page, 'me').waitFor();
    await page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await expect.poll(() => loads).toBe(2);
    await page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      await new Promise(requestAnimationFrame);
    });
    expect(
      await page
        .getByRole('button', { name: 'Approve', exact: true })
        .isDisabled(),
    ).toBe(true);
    await page.getByRole('textbox', { name: 'Machine name' }).press('Enter');
    expect(approvals).toEqual([]);
    expect(
      await page.getByRole('button', { name: 'Deny', exact: true }).isEnabled(),
    ).toBe(true);
    await bucketCheck(page, 'All buckets').check();
    expect(
      await page
        .getByRole('button', { name: 'Approve', exact: true })
        .isEnabled(),
    ).toBe(true);
    await bucketCheck(page, 'All buckets').uncheck();
    held.resolve();
    await expect
      .poll(() =>
        page.getByRole('button', { name: 'Approve', exact: true }).isEnabled(),
      )
      .toBe(true);
    expect(await bucketCheck(page, 'me').isChecked()).toBe(true);
    expect(await bucketCheck(page, 'All buckets').isChecked()).toBe(false);
  } finally {
    held.resolve();
    await close();
  }
});
it.each(['successful', 'failed-then-retried'])(
  'E5/E29/E30: a %s bucket refresh removes deleted choices before approval of a different branch',
  async (refresh) => {
    const { page, app, reveal, approvals, close } = await grantPage(browser);
    try {
      await reveal();
      await selectDeep(page);
      await (await app.mf.getD1Database('DB'))
        .prepare("DELETE FROM buckets WHERE path LIKE 'work/acme%'")
        .run();
      if (refresh === 'failed-then-retried')
        await page.route('**/api/buckets', (route) => route.abort());
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      await page.getByText(/selected buckets.*choose again/i).waitFor();
      if (refresh === 'failed-then-retried') {
        await page
          .getByText("Couldn't load buckets", { exact: true })
          .waitFor();
        expect(await bucketCheck(page, 'All buckets').isChecked()).toBe(false);
        expect(
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .isDisabled(),
        ).toBe(true);
        await page.unroute('**/api/buckets');
        await page
          .getByRole('button', { name: 'Try again', exact: true })
          .click();
      }
      await expect
        .poll(() => bucketCheck(page, 'work/acme').count())
        .toBe(0);
      await bucketCheck(page, 'personal/finances').check();
      const approved = page.waitForResponse((response) =>
        response.url().endsWith('/approve'),
      );
      await page.getByRole('button', { name: 'Approve', exact: true }).click();
      expect((await approved).status()).toBe(204);
      expect(approvals.at(-1)).toEqual({
        machineName: 'omarchy',
        grant: ['personal/finances'],
      });
      await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    } finally {
      await close();
    }
  },
);
it('E32: a completed preload is retained when the approval page chunk arrives later', async () => {
  let loads = 0;
  let heldChunk = false;
  const { page, reveal, close } = await grantPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (request.url().endsWith('/api/buckets')) loads++;
      });
      await page.route('**/authorize-page-*.js', async (route) => {
        heldChunk = true;
        await page.waitForFunction(() =>
          performance
            .getEntriesByType('resource')
            .some(
              (entry) =>
                entry.name.endsWith('/api/buckets') &&
                (entry as PerformanceResourceTiming).responseEnd > 0,
            ),
        );
        await route.continue();
      });
    },
  });
  try {
    await page.waitForLoadState('networkidle');
    expect(heldChunk).toBe(true);
    await reveal();
    await bucketCheck(page, 'me').waitFor();
    await page.waitForLoadState('networkidle');
    expect(loads).toBe(1);
    expect(
      await page.getByRole('status', { name: 'Loading buckets' }).count(),
    ).toBe(0);
  } finally {
    await close();
  }
});
