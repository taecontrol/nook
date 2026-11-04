import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import { approvalFixture, pending, setMark } from './support/owner-approval.ts';

let app: Awaited<ReturnType<typeof approvalFixture>>;
let approvalId: string;
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  app = await approvalFixture();
  await setMark(app);
  approvalId = (await pending(app, app.token)).id;
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  try {
    await closeBrowser();
  } finally {
    await app.close();
  }
});

it.each(['ownerApproval', 'approvalsNavigation'] as const)(
  'E39: %s measures the real approval first screen on the existing 4G 390×844 phone',
  async (kind) => {
    const { context, page } = await phonePage(browser, kind);
    try {
      // Timing requires native performance marks; no simulated browser clock.
      expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
      const measured = await measureScreen(page, app.origin, '', kind, {
        approvalId,
      });
      expect(Number.isFinite(measured)).toBe(true);
      expect(measured).toBeGreaterThanOrEqual(0);
      if (kind === 'ownerApproval') {
        expect(new URL(page.url()).pathname).toBe(`/approvals/${approvalId}`);
        expect(
          await page
            .getByRole('heading', { name: 'Approve this run?', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await page.getByRole('radio').count()).toBe(3);
      } else {
        expect(new URL(page.url()).pathname).toBe('/approvals');
        expect(
          await page.locator(`a[href="/approvals/${approvalId}"]`).isVisible(),
        ).toBe(true);
      }
    } finally {
      await context.close();
    }
  },
);
