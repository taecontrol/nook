import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import { vaultRuntime } from './support/vault.ts';
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

it.each([
  { method: 'POST', outcome: 'success' },
  { method: 'POST', outcome: 'failure' },
  { method: 'DELETE', outcome: 'success' },
  { method: 'DELETE', outcome: 'failure' },
] as const)(
  'Vault preserves a pending optimistic bucket $method through navigation and real tab refocus ($outcome)',
  async ({ method, outcome }) => {
    const app = await vaultRuntime();
    try {
      const visible = await visibilityBrowser();
      const { page, context } = visible;
      const gate = deferred();
      const started = deferred();
      const path = 'work/pending-vault';
      let gets = 0;
      let writes = 0;
      try {
        await page.setViewportSize({ width: 1440, height: 900 });
        if (method === 'DELETE') {
          const created = await fetch(`${app.origin}/api/buckets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ path }),
          });
          expect(created.status).toBe(200);
        }
        page.on('request', (request) => {
          if (
            new URL(request.url()).pathname === '/api/buckets' &&
            request.method() === 'GET'
          )
            gets++;
        });
        await page.route('**/api/buckets**', async (route) => {
          if (route.request().method() === method) {
            writes++;
            started.resolve();
            // Hold the write before the Worker sees it: a concurrent list is stale.
            await gate.promise;
            if (outcome === 'failure')
              return route.fulfill({
                status: 503,
                json: { _tag: 'ServiceUnavailable' },
              });
          }
          await route.continue();
        });
        await page.goto(`${app.origin}/buckets`);
        await page.locator('[data-path="work"]').waitFor();
        await startBucketWrite(page, method, path);
        await started.promise;
        const optimisticCount = method === 'POST' ? 1 : 0;
        await expect
          .poll(() => page.locator(`[data-path="${path}"]`).count())
          .toBe(optimisticCount);
        const initial = gets;
        await page.getByRole('link', { name: 'Vault', exact: true }).click();
        const row = page
          .getByRole('navigation', { name: 'Buckets', exact: true })
          .locator(`[data-path="${path}"]`);
        await page
          .getByRole('heading', { name: 'Vault', exact: true })
          .waitFor();
        await expect.poll(() => row.count()).toBe(optimisticCount);
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
        await expect
          .poll(async () => ({ gets, bucketCount: await row.count() }))
          .toEqual({ gets: initial, bucketCount: optimisticCount });
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
        expect((await finished).status()).toBe(
          outcome === 'failure' ? 503 : method === 'POST' ? 200 : 204,
        );
        const recovery = await recovered;
        expect(recovery.status()).toBe(200);
        const body = (await recovery.json()) as { buckets: { path: string }[] };
        const present =
          outcome === 'success' ? method === 'POST' : method === 'DELETE';
        expect(body.buckets.some((bucket) => bucket.path === path)).toBe(
          present,
        );
        await expect.poll(() => row.count()).toBe(present ? 1 : 0);
        expect(gets).toBe(initial + 1);
        expect(writes).toBe(1);
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
