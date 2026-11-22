import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { grantPage } from './support/grant-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it.each([0, 90])(
  'a request follows its expiry with the browser clock %s days behind',
  async (daysBehind) => {
    const visit = await grantPage(browser, {
      configure: (page) =>
        page.clock.install({
          time: new Date(Date.now() - daysBehind * 24 * 60 * 60 * 1000),
        }),
    });
    try {
      await visit.reveal();
      await visit.page.clock.fastForward(601_000);
      if (daysBehind === 0) {
        await visit.page
          .getByRole('heading', { name: 'This request expired', exact: true })
          .waitFor();
        expect(await visit.page.locator('form').count()).toBe(0);
      } else {
        expect(
          await visit.page
            .getByRole('textbox', { name: 'Machine name', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(
          await visit.page
            .getByRole('heading', { name: 'This request expired', exact: true })
            .count(),
        ).toBe(0);
      }
    } finally {
      await visit.close();
    }
  },
);
