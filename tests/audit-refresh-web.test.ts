import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { fetchValues } from './support/audit.ts';
import { auditEntries, visitAudit } from './support/audit-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it.each([
  { count: 0, filtered: false },
  { count: 0, filtered: true },
  { count: 1, filtered: false },
  { count: 1, filtered: true },
])(
  'a failed audit refresh keeps $count cached entries, exposes its error and permits retry (filtered: $filtered)',
  async ({ count, filtered }) => {
    const visit = await visitAudit(browser, {
      count,
      start: filtered ? '/audit?bucket=work' : '/audit',
    });
    let tableUnavailable = false;
    try {
      const { page } = visit;
      if (count === 0)
        await page
          .getByText(
            filtered
              ? 'No activity matches these filters'
              : 'No secret activity yet',
            { exact: true },
          )
          .waitFor();
      else await expect.poll(() => auditEntries(page).count()).toBe(count);
      await page.waitForLoadState('networkidle');
      expect(
        await page
          .getByRole('button', { name: 'Load older entries', exact: true })
          .count(),
        'This cached page has no next page to use as a retry',
      ).toBe(0);
      const db = await visit.app.mf.getD1Database('DB');
      await db
        .prepare(
          'ALTER TABLE audit_entries RENAME TO unavailable_audit_entries',
        )
        .run();
      tableUnavailable = true;
      const failedRead = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/audit',
      );
      await page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      const failed = await failedRead;
      expect(failed.status()).toBe(503);
      await failed.finished();
      await expect.poll(() => auditEntries(page).count()).toBe(count);
      await expect
        .poll(() => page.locator('body').innerText())
        .toMatch(/(?:couldn.t|failed to) (?:load|refresh)[^\n]*entries/i);
      const retry = page.getByRole('button', {
        name: 'Try again',
        exact: true,
      });
      await expect.poll(() => retry.count()).toBe(1);
      expect(await retry.isEnabled()).toBe(true);
      await db
        .prepare(
          'ALTER TABLE unavailable_audit_entries RENAME TO audit_entries',
        )
        .run();
      tableUnavailable = false;
      const delivered = await fetchValues(visit.app, visit.token);
      expect(delivered.status).toBe(200);
      await delivered.body?.cancel();
      const recovered = page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/audit',
      );
      await retry.click();
      const response = await recovered;
      expect(response.status()).toBe(200);
      await response.finished();
      await expect.poll(() => auditEntries(page).count()).toBe(count + 1);
      await expect
        .poll(() => page.locator('body').innerText())
        .not.toMatch(/(?:couldn.t|failed to) (?:load|refresh)[^\n]*entries/i);
      expect(await retry.count()).toBe(0);
    } finally {
      try {
        if (tableUnavailable)
          await (await visit.app.mf.getD1Database('DB'))
            .prepare(
              'ALTER TABLE unavailable_audit_entries RENAME TO audit_entries',
            )
            .run();
      } finally {
        await visit.close();
      }
    }
  },
);
