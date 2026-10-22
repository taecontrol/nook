import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryClient } from './support/memory.ts';
import { fileMemory, pdfName } from './support/memory-files.ts';
import {
  filesControl,
  filesPage,
  filesSheet,
  openFiles,
  waitFileRows,
} from './support/memory-files-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('keeps an in-flight download and its peer lock when Files is dismissed and reopened', async () => {
  const gate = deferred();
  const arrived = deferred();
  let downloads = 0;
  const visit = await filesPage(browser, {
    configure: async (page) => {
      await page.route('**/api/memories/*/files/*', async (route) => {
        downloads += 1;
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page, files } = visit;
    await openFiles(page);
    const button = filesSheet(page).getByRole('button', {
      name: `Download ${files[0].name}`,
      exact: true,
    });
    await button.click();
    await arrived.promise;
    await page.keyboard.press('Escape');
    await expect.poll(() => filesSheet(page).count()).toBe(0);
    await openFiles(page);
    expect(await button.getAttribute('aria-busy')).toBe('true');
    for (const peer of await filesSheet(page)
      .getByRole('button', { name: /^Download / })
      .all())
      expect(await peer.isDisabled()).toBe(true);
    expect(downloads).toBe(1);
    const saved = page.waitForEvent('download');
    gate.resolve();
    expect((await saved).suggestedFilename()).toBe(files[0].name);
    await expect.poll(() => button.isEnabled()).toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('retains the missing-file warning when refresh fails, retries, and returns focus to History after the last file disappears', async () => {
  let unavailable = false;
  const visit = await filesPage(browser, {
    names: [pdfName],
    configure: async (page) => {
      await page.route(`**/api/memories/${fileMemory}`, (route) =>
        unavailable
          ? route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"_tag":"ServiceUnavailable"}',
            })
          : route.continue(),
      );
    },
  });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    expect(
      (
        await memoryClient(app, '2026-07-28').call('detach', {
          id: fileMemory,
          name: pdfName,
          sha256: files[0].sha256,
        })
      ).isError,
    ).not.toBe(true);
    unavailable = true;
    await filesSheet(page)
      .getByRole('button', { name: `Download ${pdfName}`, exact: true })
      .click();
    const alert = filesSheet(page).getByRole('alert');
    await alert.getByText(/Could not refresh the list/).waitFor();
    expect(await alert.innerText()).toContain('File not found.');
    expect(await alert.innerText()).not.toContain('The list is up to date.');
    await waitFileRows(page, 1);
    unavailable = false;
    await alert.getByRole('button', { name: 'Try again', exact: true }).click();
    await waitFileRows(page, 0);
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        page
          .locator('[data-memory-history]')
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    expect(await filesControl(page).count()).toBe(0);
    expect(new URL(page.url()).searchParams.has('files')).toBe(false);
  } finally {
    await visit.close();
  }
});

it('reuses cached detail on intent/open and restores a reloadable Files location with keyboard focus', async () => {
  const reads: string[] = [];
  const visit = await filesPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === `/api/memories/${fileMemory}`)
          reads.push(request.url());
      });
    },
  });
  try {
    const { page } = visit;
    await page.waitForLoadState('networkidle');
    expect(reads).toHaveLength(1);
    await filesControl(page).focus();
    await page.waitForLoadState('networkidle');
    await page.keyboard.press('Enter');
    await waitFileRows(page, 3);
    expect(reads).toHaveLength(1);
    expect(new URL(page.url()).searchParams.get('files')).toBe('1');
    await page.keyboard.press('Escape');
    await expect
      .poll(() =>
        filesControl(page).evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
    await page.goBack();
    await waitFileRows(page, 3);
    await page.reload();
    await waitFileRows(page, 3);
    await filesSheet(page)
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await expect
      .poll(() =>
        filesControl(page).evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
  } finally {
    await visit.close();
  }
});
