import { expect, it } from 'vitest';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { expectToolSuccess, mcpDriver } from './support/mcp.ts';
import { runtime } from './support/runtime.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

it.each([1_000, 31_000])(
  'E12: returning after %s ms reveals an MCP write with exactly one list and none while hidden',
  async (away) => {
    const app = await runtime();
    const browser = await visibilityBrowser();
    const { page, context } = browser;
    const lists: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().endsWith('/api/buckets'))
        lists.push(request.url());
    });
    try {
      await app.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
      });
      await page.goto(`${app.origin}/buckets`);
      await page.locator('[data-path="me"]').waitFor();
      await page.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('visible');
      expect(lists).toHaveLength(1);
      await page.clock.install({ time: new Date() });
      const other = await context.newPage();
      await other.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('hidden');
      const driver = mcpDriver(app.origin);
      expectToolSuccess(
        await driver.call('create_bucket', { path: 'work/acme' }),
        {
          path: 'work/acme',
          created: true,
          createdAncestors: ['work'],
        },
      );
      await page.clock.fastForward(away);
      expect(lists).toHaveLength(1);
      expect(await page.locator('[data-path="work/acme"]').count()).toBe(0);
      await page.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('visible');
      await expect
        .poll(() =>
          page
            .locator('li[data-bucket="work"] ul [data-path="work/acme"]')
            .count(),
        )
        .toBe(1);
      await page.clock.fastForward(1_000);
      expect(lists).toHaveLength(2);
    } finally {
      await closeBrowserPage(page, context);
      await browser.close();
      await app.close();
    }
  },
);

it.each(['POST', 'DELETE'])(
  'returning to a tab during an optimistic %s preserves the pending outline until recovery',
  async (method) => {
    const app = await runtime();
    const browser = await visibilityBrowser();
    const { page, context } = browser;
    let release = () => {};
    const pending = new Promise<void>((accept) => {
      release = accept;
    });
    const lists: string[] = [];
    page.on('request', (request) => {
      if (request.method() === 'GET' && request.url().endsWith('/api/buckets'))
        lists.push(request.url());
    });
    try {
      await app.setBindings({
        LOCAL_OWNER: 'synthetic-owner',
        LOCAL_ORIGIN: app.origin,
      });
      if (method === 'DELETE')
        expectToolSuccess(
          await mcpDriver(app.origin).call('create_bucket', {
            path: 'work/acme',
          }),
          { path: 'work/acme', created: true, createdAncestors: ['work'] },
        );
      await page.goto(`${app.origin}/buckets`);
      await page.locator('[data-path="me"]').waitFor();
      await page.clock.install({ time: new Date() });
      await page.route('**/api/buckets**', async (route) => {
        if (route.request().method() === method) await pending;
        await route.continue();
      });
      if (method === 'POST') {
        const field = page.getByRole('textbox', { name: 'New bucket path' });
        await field.fill('work/acme');
        await field.press('Enter');
      } else {
        await page
          .getByRole('button', {
            name: 'Actions for work/acme',
            exact: true,
          })
          .click();
        await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
        await page
          .getByRole('button', { name: 'Delete bucket', exact: true })
          .click();
      }
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      await expect.poll(() => field.isDisabled()).toBe(true);
      const other = await context.newPage();
      await other.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('hidden');
      await page.clock.fastForward(31_000);
      await page.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('visible');
      await page.clock.fastForward(1_000);
      expect(lists).toHaveLength(1);
      expect(await page.locator('[data-path="work/acme"]').count()).toBe(
        method === 'POST' ? 1 : 0,
      );
      expect(await field.isDisabled()).toBe(true);
      const response = page.waitForResponse(
        (response) => response.request().method() === method,
      );
      release();
      expect((await response).status()).toBe(method === 'POST' ? 200 : 204);
      await expect.poll(() => field.isEnabled()).toBe(true);
      expect(lists).toHaveLength(2);
    } finally {
      release();
      await closeBrowserPage(page, context);
      await browser.close();
      await app.close();
    }
  },
);
