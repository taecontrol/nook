import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { memoryClient, memoryId, typicalMemories } from './support/memory.ts';
import {
  confirmForget,
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

it.each([false, true])(
  'dismissing an unconfirmed committed forget focuses the neighbor or list heading; last memory=%s',
  async (last) => {
    const visit = await forgetPage(browser, {
      seeds: last ? [typicalMemories[0]] : typicalMemories,
    });
    try {
      const { page } = visit;
      await openForget(page);
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        expect((await route.fetch()).status()).toBe(204);
        await route.abort();
      });
      await page.route(`**/api/memories/${forgottenId}`, (route) =>
        route.abort(),
      );
      await confirmForget(page);
      const alert = page.getByRole('alert').filter({
        hasText: 'Forget not confirmed',
      });
      await alert.waitFor();
      // Finish the real post-write list refetch before dismissing its notice.
      await page.waitForLoadState('networkidle');
      expect(
        await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
      ).toBe(0);
      await alert.getByRole('button', { name: 'Dismiss', exact: true }).click();
      await alert.waitFor({ state: 'hidden' });
      const destination = page.locator(
        last
          ? '[data-memory-list-heading]'
          : `[data-memory-row="${memoryId(2)}"]`,
      );
      await expect
        .poll(() => destination.evaluate((el) => document.activeElement === el))
        .toBe(true);
    } finally {
      await visit.close();
    }
  },
);

it('dismissing a failed conflict refresh returns focus to the memory row', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page, app } = visit;
    await openForget(page);
    const client = memoryClient(app, '2026-07-28');
    const original = (await client.call('get', { id: forgottenId }))
      .structuredContent;
    expect(
      (
        await client.call('update', {
          id: forgottenId,
          expectedVersion: 3,
          content: original?.content,
          tags: ['changed'],
        })
      ).isError,
    ).not.toBe(true);
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.abort(),
    );
    await confirmForget(page);
    await page
      .getByRole('button', { name: 'Refresh memory', exact: true })
      .click();
    const failure = page
      .getByRole('alert')
      .filter({ hasText: 'Could not check this memory' });
    await failure.waitFor();
    await failure.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await failure.waitFor({ state: 'hidden' });
    await expect
      .poll(() =>
        page
          .locator(`[data-memory-row="${forgottenId}"]`)
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
  } finally {
    await visit.close();
  }
});

it('a failed Check again shows its reason once in the unconfirmed alert', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.abort(),
    );
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
    );
    await confirmForget(page);
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await alert.waitFor();
    await page.waitForLoadState('networkidle');
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
    await alert
      .getByRole('button', { name: 'Check again', exact: true })
      .click();
    await (await checked).finished();
    await page.waitForLoadState('networkidle');
    await expect
      .poll(() =>
        alert
          .getByRole('button', { name: 'Check again', exact: true })
          .isEnabled(),
      )
      .toBe(true);
    expect(await alert.innerText()).toContain('Nook is unavailable right now.');
    expect(
      await page
        .getByRole('alert')
        .filter({ hasText: 'Nook is unavailable right now.' })
        .count(),
    ).toBe(1);
    expect(
      await page
        .getByText('Could not check this memory', { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
