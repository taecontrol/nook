import type { Browser } from 'playwright';
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
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      ++reads === 1 ? route.abort() : route.continue(),
    );
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
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
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
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    expect(requests).toBe(0);
    await page.clock.resume();
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
