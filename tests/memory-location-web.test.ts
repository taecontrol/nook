import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { memoryFixture, memoryId, memoryPage } from './support/memory.ts';
import { historyPage, memories } from './support/memory-history.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('version rows preserve the selected memory URL parameter order', async () => {
  const visit = await historyPage(browser, {
    state: '&scope=inherited&history=1',
  });
  try {
    const row = visit.page.locator('[data-version-row="2"]');
    await row.waitFor();
    expect(await row.getAttribute('href')).toBe(
      `/memory?bucket=work%2Facme&memory=${memories[0].id}&scope=inherited&history=1&version=2`,
    );
    await row.click();
    await visit.page.getByRole('heading', { name: 'Version 2 of 4' }).waitFor();
    expect(new URL(visit.page.url()).search).toBe(
      `?bucket=work%2Facme&memory=${memories[0].id}&scope=inherited&history=1&version=2`,
    );
  } finally {
    await visit.close();
  }
});

it('typing a search preserves the selected memory URL parameter order', async () => {
  const visit = await memoryPage(browser, {
    start: `/memory?bucket=work/acme&memory=${memoryId(1)}&scope=inherited`,
  });
  try {
    const search = visit.page.getByRole('textbox', {
      name: 'Search memories visible in work/acme',
    });
    await search.fill('release');
    await search.press('Enter');
    await expect
      .poll(() => new URL(visit.page.url()).search)
      .toBe(
        `?bucket=work%2Facme&memory=${memoryId(1)}&scope=inherited&q=release`,
      );
  } finally {
    await visit.close();
  }
});

it('automatic desktop selection appends defaults after the original query', async () => {
  const visit = await memoryPage(browser, {
    seeds: [memoryFixture(1, { bucket: 'me', content: '# Release process' })],
    start: '/memory?q=release',
  });
  try {
    await visit.page.locator('[data-search-result]').first().waitFor();
    await expect
      .poll(() => new URL(visit.page.url()).search)
      .toBe(`?q=release&bucket=me&scope=inherited&memory=${memoryId(1)}`);
  } finally {
    await visit.close();
  }
});
