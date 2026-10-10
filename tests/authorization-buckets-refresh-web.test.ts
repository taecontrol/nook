import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { jsonRequest, ownerRuntime } from './support/authorizations.ts';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { runtime } from './support/runtime.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

async function startBucketWrite(
  page: Page,
  method: 'POST' | 'DELETE',
  path: string,
) {
  if (method === 'POST') {
    const field = page.getByRole('textbox', {
      name: 'New bucket path',
      exact: true,
    });
    await field.fill(path);
    await field.press('Enter');
    return;
  }
  await page
    .getByRole('button', { name: `Actions for ${path}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
  await page
    .getByRole('button', { name: 'Delete bucket', exact: true })
    .click();
}

it.each(['POST', 'DELETE'] as const)(
  'returning to authorization through history preserves a pending bucket %s through real tab refocus',
  async (method) => {
    const app = await ownerRuntime(await runtime());
    try {
      await seedGrantTree(app);
      const visible = await visibilityBrowser();
      const { page, context } = visible;
      const gate = deferred();
      const started = deferred();
      const path = 'work/pending-authorization';
      let gets = 0;
      let writes = 0;
      let authorizationRequests = 0;
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        if (method === 'DELETE')
          expect(
            (await jsonRequest(app, '/api/buckets', { path })).status,
          ).toBe(200);
        page.on('request', (request) => {
          const pathname = new URL(request.url()).pathname;
          if (pathname === '/api/buckets' && request.method() === 'GET') gets++;
          if (pathname.startsWith('/api/authorizations/'))
            authorizationRequests++;
        });
        await page.route('**/api/buckets**', async (route) => {
          if (route.request().method() === method) {
            writes++;
            started.resolve();
            // A list fetched before this write reaches the Worker is stale.
            await gate.promise;
          }
          await route.continue();
        });
        await page.goto(`${app.origin}/cli/authorize`);
        await page
          .getByRole('textbox', { name: 'Code from your terminal' })
          .waitFor();
        await page
          .getByRole('link', { name: 'Back to Nook', exact: true })
          .click();
        await page.getByRole('link', { name: 'Buckets', exact: true }).click();
        await page.locator('[data-path="work"]').waitFor();
        await startBucketWrite(page, method, path);
        await started.promise;
        const optimisticCount = method === 'POST' ? 1 : 0;
        const row = page.locator(`[data-path="${path}"]`);
        await expect.poll(() => row.count()).toBe(optimisticCount);
        const initial = gets;
        await page.goBack();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/');
        await page.goBack();
        await page
          .getByRole('textbox', { name: 'Code from your terminal' })
          .waitFor();
        const other = await context.newPage();
        await other.bringToFront();
        await expect
          .poll(() => page.evaluate(() => document.visibilityState))
          .toBe('hidden');
        await page.bringToFront();
        await expect
          .poll(() => page.evaluate(() => document.visibilityState))
          .toBe('visible');
        await page.evaluate(
          () =>
            new Promise((resolve) =>
              requestAnimationFrame(() => requestAnimationFrame(resolve)),
            ),
        );
        await page.goForward();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/');
        await page.goForward();
        await page
          .getByRole('heading', { name: 'Buckets', exact: true })
          .waitFor();
        await expect
          .poll(async () => ({ gets, bucketCount: await row.count() }))
          .toEqual({ gets: initial, bucketCount: optimisticCount });
        expect(authorizationRequests).toBe(0);
        expect(writes).toBe(1);
        const finished = page.waitForResponse(
          (response) => response.request().method() === method,
        );
        const recovered = page.waitForResponse(
          (response) =>
            new URL(response.url()).pathname === '/api/buckets' &&
            response.request().method() === 'GET',
        );
        gate.resolve();
        expect((await finished).status()).toBe(method === 'POST' ? 200 : 204);
        const recovery = await recovered;
        expect(recovery.status()).toBe(200);
        const body = (await recovery.json()) as { buckets: { path: string }[] };
        expect(body.buckets.some((bucket) => bucket.path === path)).toBe(
          method === 'POST',
        );
        await expect.poll(() => row.count()).toBe(optimisticCount);
        expect(gets).toBe(initial + 1);
        expect(writes).toBe(1);
        expect(authorizationRequests).toBe(0);
      } finally {
        gate.resolve();
        try {
          await page.unrouteAll({ behavior: 'wait' });
          await observeBrowserPage(page);
        } finally {
          await visible.close();
        }
      }
    } finally {
      await app.close();
    }
  },
);
