import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  confirmForget,
  forgetMemory,
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
const rendered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
it.each(['list', 'search', 'counts'] as const)(
  'an authoritative Check again reconciles cached %s before recovery reads settle',
  async (kind) => {
    const gate = deferred();
    const arrived = deferred();
    let checking = false;
    const visit = await forgetPage(browser, {
      start: `/memory?bucket=work/acme&memory=${forgottenId}${kind === 'search' ? '&q=release' : ''}`,
    });
    try {
      const { page, app } = visit;
      const row = page.locator(
        `[${kind === 'search' ? 'data-search-result' : 'data-memory-row'}="${forgottenId}"]`,
      );
      await row.waitFor();
      await openForget(page);
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        if (kind === 'counts') expect((await route.fetch()).status()).toBe(204);
        await route.abort();
      });
      await page.route(`**/api/memories/${forgottenId}`, (route) =>
        checking ? route.continue() : route.abort(),
      );
      await confirmForget(page);
      const unknown = page
        .getByRole('alert')
        .filter({ hasText: 'Forget not confirmed' });
      await unknown.waitFor();
      if (kind !== 'counts') await row.waitFor();
      const count = page.locator('[data-path="work/acme"]');
      await expect
        .poll(() => count.innerText())
        .toContain(kind === 'counts' ? '2 memories' : '3 memories');
      if (kind !== 'counts') await forgetMemory(app, forgottenId, 3);
      const pattern =
        kind === 'list'
          ? '**/api/memories?*'
          : kind === 'search'
            ? '**/api/memories/search?*'
            : '**/api/memories/counts';
      await page.route(pattern, async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(200);
        arrived.resolve();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
      checking = true;
      const checked = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === `/api/memories/${forgottenId}` &&
          response.status() === 404,
      );
      await unknown.getByRole('button', { name: 'Check again' }).click();
      await (await checked).finished();
      await arrived.promise;
      await rendered(page);
      if (kind === 'counts')
        expect(await count.innerText()).toContain('2 memories');
      else expect(await row.count()).toBe(0);
      gate.resolve();
      await page.getByText('Forgot Release process', { exact: true }).waitFor();
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
it('a late prefetched list cannot restore an authoritatively forgotten row', async () => {
  const gate = deferred();
  const arrived = deferred();
  const delivered = deferred();
  let checking = false;
  let reads = 0;
  const visit = await forgetPage(browser);
  try {
    const { page, app } = visit;
    const row = page.locator(`[data-memory-row="${forgottenId}"]`);
    await row.waitFor();
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.abort(),
    );
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      checking ? route.continue() : route.abort(),
    );
    await confirmForget(page);
    const unknown = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await unknown.waitFor();
    await row.waitFor();
    await page.route('**/api/memories?*', async (route) => {
      if (
        new URL(route.request().url()).searchParams.get('bucket') !==
          'work/acme/api' ||
        ++reads !== 1
      )
        return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      expect(
        (await response.json()).memories.some(
          (memory: { id: string }) => memory.id === forgottenId,
        ),
      ).toBe(true);
      arrived.resolve();
      await gate.promise;
      await route.fulfill({ response }).catch(() => {});
      delivered.resolve();
    });
    await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'));
    const child = page.locator('[data-path="work/acme/api"]').getByRole('link');
    await child.hover();
    await arrived.promise;
    await forgetMemory(app, forgottenId, 3);
    checking = true;
    await unknown.getByRole('button', { name: 'Check again' }).click();
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    gate.resolve();
    await delivered.promise;
    await page.waitForLoadState('networkidle');
    await rendered(page);
    await child.click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('bucket'))
      .toBe('work/acme/api');
    await page
      .locator('[data-memory-list-heading]')
      .filter({ hasText: 'work/acme/api' })
      .waitFor();
    await page.waitForLoadState('networkidle');
    await rendered(page);
    expect(await row.count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
