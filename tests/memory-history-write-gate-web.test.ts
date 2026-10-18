import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryClient, memoryId } from './support/memory.ts';
import {
  confirmForget,
  forgetPage,
  forgottenId,
  memoryQueries,
  openForget,
} from './support/memory-forget.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('history reconciliation waits for a pending forget when another reader learns a newer head', async () => {
  const visit = await forgetPage(browser);
  const gate = deferred();
  const arrived = deferred();
  let reads = 0;
  try {
    const { page, app } = visit;
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page.locator('[data-version-row="3"]').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.route(`**/api/memories/${forgottenId}/versions**`, (route) => {
      reads++;
      return route.continue();
    });
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await openForget(page, memoryId(2));
    await confirmForget(page);
    await arrived.promise;
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page.locator('[data-history-sheet]').waitFor();
    const client = memoryClient(app, '2026-07-28');
    expect(
      (
        await client.call('update', {
          id: forgottenId,
          expectedVersion: 3,
          content: '# Release process\n\nA newer authoritative head.',
        })
      ).isError,
    ).not.toBe(true);
    const response = await fetch(`${app.origin}/api/memories/${forgottenId}`);
    expect(response.status).toBe(200);
    const newer = await response.json();
    const queries = await memoryQueries(page);
    try {
      // Model a second reader publishing the genuine head while this Sheet
      // still holds its earlier successful history.
      await queries.evaluate(
        (client, head) => client.setQueryData(['memory', head.id], head),
        newer,
      );
      await expect
        .poll(() => page.locator('[data-history-sheet]').innerText())
        .toContain('4 versions of “Release process”, newest first.');
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        reads,
        'The reconciliation effect must respect the write gate',
      ).toBe(0);
      gate.resolve();
      await page.locator('[data-version-row="4"]').waitFor();
      expect(reads).toBeGreaterThan(0);
    } finally {
      await queries.dispose();
    }
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('history retry checks the live gate before the pending render disables its button', async () => {
  const visit = await forgetPage(browser);
  const gate = deferred();
  const arrived = deferred();
  let reads = 0;
  let fail = true;
  try {
    const { page } = visit;
    await page.route(`**/api/memories/${forgottenId}/versions**`, (route) => {
      reads++;
      return fail
        ? route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        : route.continue();
    });
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page
      .getByRole('button', { name: 'Retry history', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await openForget(page, memoryId(2));
    // Browser Back can reopen History while the forget confirmation is open.
    await page.goBack();
    await page.locator('[data-history-sheet]').waitFor();
    await page.waitForLoadState('networkidle');
    const queries = await memoryQueries(page);
    try {
      const stop = await queries.evaluateHandle((client) => {
        let clicked = false;
        return client.getMutationCache().subscribe((event) => {
          if (
            clicked ||
            event.type !== 'updated' ||
            event.action.type !== 'pending'
          )
            return;
          clicked = true;
          const retry = [
            ...document.querySelectorAll<HTMLButtonElement>(
              '[data-history-sheet] button',
            ),
          ].find((button) => button.textContent === 'Retry history');
          if (!retry || retry.disabled)
            throw new Error('The pre-render retry must still be enabled.');
          retry.click();
        });
      });
      reads = 0;
      fail = false;
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
      await page
        .getByRole('alertdialog', { includeHidden: true })
        .getByRole('button', {
          name: 'Forget memory',
          exact: true,
          includeHidden: true,
        })
        .evaluate((button: HTMLButtonElement) => button.click());
      await arrived.promise;
      await page.evaluate(
        () =>
          new Promise<void>((resolve) =>
            requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
          ),
      );
      expect(
        reads,
        'Retry must not bypass the gate before its disabled render',
      ).toBe(0);
      expect(
        await page
          .getByRole('button', { name: 'Retry history', exact: true })
          .isDisabled(),
      ).toBe(true);
      await stop.evaluate((unsubscribe) => unsubscribe());
      await stop.dispose();
      gate.resolve();
      await page.locator('[data-version-row="3"]').waitFor();
      expect(reads).toBeGreaterThan(0);
    } finally {
      await queries.dispose();
    }
  } finally {
    gate.resolve();
    await visit.close();
  }
});
