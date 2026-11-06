import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { acmePath, runFixture } from './support/audit.ts';
import { filesRuntime } from './support/memory-files-runtime.ts';
import { pending, setMark, view } from './support/owner-approval.ts';
import {
  approvalBrowserPage,
  approvalNow,
  approveButton,
  duration,
  expectNoDecisionControls,
  expectPendingPage,
} from './support/owner-approval-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
let clock: Awaited<ReturnType<typeof filesRuntime>>;
let app: Awaited<ReturnType<typeof runFixture>>;
let ui: Awaited<ReturnType<typeof approvalBrowserPage>>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser());
beforeEach(async () => {
  clock = await filesRuntime({ now: approvalNow.getTime() });
  app = await runFixture('all', undefined, clock);
  await setMark(app);
  ui = await approvalBrowserPage(browser);
});
afterEach(async () => {
  try {
    await ui.close();
  } finally {
    await app.close();
  }
});

it.each(['expired', 'network'] as const)(
  'E31/E33/E43: history navigation to another pending approval clears %s decision feedback',
  async (failure) => {
    const a = await pending(app, app.token, undefined, {
      secrets: [acmePath],
      purpose: 'Request A',
    });
    const b = await pending(app, app.token, undefined, {
      secrets: [acmePath],
      purpose: 'Request B',
    });
    expect(Date.parse(b.expiresAt)).toBeGreaterThan(Date.parse(a.expiresAt));
    const { page } = ui;
    await page.goto(b.url);
    await expectPendingPage(page);
    await page
      .getByRole('link', { name: 'All approvals', exact: true })
      .click();
    await page.locator(`a[href="/approvals/${a.id}"]`).click();
    await expectPendingPage(page);
    await duration(page, '1 hour').click();
    if (failure === 'expired') {
      // Change only the server clock: A has expired while B remains pending,
      // and the browser still offers the decision it loaded before that edge.
      clock.setTime(Date.parse(a.expiresAt));
      const answered = page.waitForResponse(
        (r) => r.url() === `${app.origin}/api/approvals/${a.id}/approve`,
      );
      await approveButton(page).click();
      expect((await answered).status()).toBe(410);
      await page
        .getByRole('heading', { name: 'This request expired', exact: true })
        .waitFor();
      expect(await page.getByRole('alert').innerText()).toContain(
        "Your 1 hour approval wasn't saved",
      );
      await expectNoDecisionControls(page);
      expect(await view(app, a.id)).toMatchObject({ state: 'expired' });
    } else {
      await page.route(`**/api/approvals/${a.id}/approve`, (route) =>
        route.abort('failed'),
      );
      await approveButton(page).click();
      await page
        .getByRole('alert')
        .filter({ hasText: "Couldn't confirm your choice" })
        .waitFor();
      await expectPendingPage(page);
    }
    expect(await view(app, b.id)).toMatchObject({ state: 'pending' });
    // Skip the list entry, so the router changes the detail ID directly.
    await page.evaluate(() => history.go(-2));
    await expect
      .poll(() => new URL(page.url()).pathname)
      .toBe(`/approvals/${b.id}`);
    await expectPendingPage(page);
    await expect
      .poll(() => page.locator('main').innerText())
      .toContain('Request B');
    expect(await page.getByRole('alert').count()).toBe(0);
    expect(
      await duration(page, 'Only this time').getAttribute('aria-checked'),
    ).toBe('true');
    expect(await approveButton(page).isEnabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Deny', exact: true }).isEnabled(),
    ).toBe(true);
    for (const control of await page.getByRole('radio').all())
      expect(await control.isEnabled()).toBe(true);
  },
);
