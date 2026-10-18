import type { Browser, Request } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryPage, memoryRows } from './support/memory.ts';
import {
  confirmForget,
  forgetDialog,
  forgetPage,
  forgottenId,
  openForget,
  uniqueTerm,
} from './support/memory-forget.ts';
import { vaultPage } from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('Check again restores a search result after an unconfirmed forget', async () => {
  const arrived = deferred();
  const gate = deferred();
  const visit = await forgetPage(browser, {
    start: `/memory?bucket=work/acme&memory=${forgottenId}&scope=inherited&q=${uniqueTerm}`,
  });
  try {
    const { page } = visit;
    const result = page.locator(`[data-search-result="${forgottenId}"]`);
    await result.waitFor();
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.abort();
    });
    let reads = 0;
    let checking = false;
    let checkRequest: Request | undefined;
    await page.route(`**/api/memories/${forgottenId}`, (route) => {
      if (++reads === 1) return route.abort();
      if (checking) checkRequest ??= route.request();
      return route.continue();
    });
    await confirmForget(page);
    await arrived.promise;
    await page
      .getByText('Forgetting Release process…', { exact: true })
      .waitFor();
    expect(await result.count()).toBe(0);
    gate.resolve();
    const unknown = page.getByRole('alert').filter({
      hasText: 'Forget not confirmed',
    });
    await unknown.waitFor();
    // Let the automatic detail refire finish before observing the explicit read.
    await page.waitForLoadState('networkidle');
    const checked = page.waitForResponse(
      (response) => response.request() === checkRequest,
    );
    checking = true;
    await unknown.getByRole('button', { name: 'Check again' }).click();
    expect(await (await checked).json()).toMatchObject({ version: 3 });
    await expect.poll(() => result.count()).toBe(1);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('desktop Memory defaults to me when the URL has no bucket', async () => {
  const visit = await memoryPage(browser, { start: '/memory' });
  try {
    await visit.page
      .getByRole('region', {
        name: 'Memories visible in me',
        exact: true,
      })
      .waitFor();
    await memoryRows(visit.page).first().waitFor();
    expect(new URL(visit.page.url()).searchParams.get('bucket')).toBe('me');
  } finally {
    await visit.close();
  }
});

it('whitespace-only typing leaves q absent and sends no search requests', async () => {
  let requests = 0;
  const visit = await memoryPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/memories/search')
          requests++;
      });
    },
  });
  try {
    const { page } = visit;
    await memoryRows(page).first().waitFor();
    const time = new Date('2026-10-13T15:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1000));
    const search = page.getByRole('textbox', {
      name: 'Search memories visible in work/acme',
    });
    await search.fill('   ');
    await search.press('Enter');
    await page.clock.runFor(251);
    await page.clock.resume();
    // Flush React's scheduled work and deliver any resulting network events.
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    expect(requests).toBe(0);
  } finally {
    await visit.close();
  }
});

it('forget explains that agents in child buckets also find the memory', async () => {
  const visit = await forgetPage(browser);
  try {
    await openForget(visit.page);
    expect(await forgetDialog(visit.page).textContent()).toContain(
      'Agents working in work/acme or a bucket inside it',
    );
  } finally {
    await visit.close();
  }
});

it('the Vault sheet explains access from child buckets', async () => {
  const visit = await vaultPage(browser);
  try {
    await visit.page
      .getByRole('button', { name: 'New secret', exact: true })
      .click();
    const sheet = visit.page.getByRole('dialog');
    await sheet.waitFor();
    expect(await sheet.textContent()).toContain(
      'Agents working in work/acme or a bucket inside it',
    );
  } finally {
    await visit.close();
  }
});

it('a failed bucket refetch uses a replacement failure when the Memory tree is hidden', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    const nav = page.getByRole('navigation', { name: 'Memory buckets' });
    await nav.locator('[data-path="work/acme"]').waitFor();
    await page.route('**/api/buckets', (route) =>
      route.fulfill({
        status: 503,
        json: { _tag: 'ServiceUnavailable' },
      }),
    );
    await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'));
    const failed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/buckets' &&
        response.status() === 503,
    );
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await (await failed).finished();
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
    await page.goBack();
    await nav.getByText('Could not load buckets', { exact: true }).waitFor();
    expect(await nav.locator('[data-path]').count()).toBe(0);
    expect(await nav.getByRole('alert').count()).toBe(0);
    expect(await nav.innerText()).toContain('Nook is unavailable right now.');
    await page.unroute('**/api/buckets');
    await nav.getByRole('button', { name: 'Retry buckets' }).click();
    await nav.locator('[data-path="work/acme"]').waitFor();
  } finally {
    await visit.close();
  }
});
