import type { Browser } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { issueToken } from './support/authorizations.ts';
import { observeBrowserPage } from './support/buckets-browser.ts';
import {
  cloudflare,
  database,
  decide,
  setMark,
  stripe,
} from './support/owner-approval.ts';
import {
  type ApprovalApp,
  approvalBrowserPage,
  approvalNow,
  approvalWebApp,
  longPurpose,
  webPending,
} from './support/owner-approval-browser.ts';
import { expectNoOverflow } from './support/page-checks.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
let app: ApprovalApp;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser());
beforeEach(async () => {
  app = await approvalWebApp();
  await setMark(app);
  await setMark(app, cloudflare, 'secret');
});
afterEach(() => app.close());

it('E36: the sidebar badge leads to pending reviews and read-only remembered approvals shared by every agent on a machine', async () => {
  const first = await webPending(app);
  const many = await webPending(app, {
    secrets: [stripe, database, cloudflare],
    purpose: longPurpose,
  });
  const remembered = await webPending(app, { secrets: [stripe, database] });
  expect((await decide(app, remembered.id, '1h')).status).toBe(200);
  const other = await issueToken(app, 'lg16');
  const later = await webPending(
    { ...app, token: other.token },
    { secrets: [cloudflare] },
  );
  expect((await decide(app, later.id, '12h')).status).toBe(200);
  const ui = await approvalBrowserPage(browser);
  const { page } = ui;
  try {
    await page.goto(app.origin);
    const link = page
      .locator('[data-sidebar="menu-item"]')
      .filter({ has: page.getByRole('link', { name: /^Approvals/ }) });
    await expect
      .poll(() => link.count(), {
        message: 'The sidebar exposes Approvals with its pending-count badge',
      })
      .toBe(1);
    await expect.poll(() => link.innerText()).toContain('2');
    await link.getByRole('link', { name: /^Approvals/ }).click();
    await page
      .getByRole('heading', { name: 'Approvals', exact: true })
      .waitFor();
    expect(new URL(page.url()).pathname).toBe('/approvals');
    const text = await page.locator('main').innerText();
    for (const copy of [
      'Waiting for you',
      'Remembered',
      'Each request expires 10 minutes after the run asked.',
      'Any later run on the same machine uses these secrets without asking until the approval ends, whichever agent runs it.',
      'omarchy',
      'lg16',
      'Ends 11:42',
      '1 hour',
      'Ends 22:42',
      '12 hours',
      stripe,
      database,
      cloudflare,
      'Claimed:',
    ])
      expect(text.toLowerCase()).toContain(copy.toLowerCase());
    const reviews = page.getByRole('link', { name: 'Review', exact: true });
    expect(await reviews.count()).toBe(2);
    for (const request of [first, many]) {
      const review = page.locator(`a[href="/approvals/${request.id}"]`);
      expect(await review.innerText()).toContain('Review');
      const row = page.locator('[data-approval]').filter({ has: review });
      expect(await row.innerText()).toContain('8:42 left');
      expect(await row.innerText()).toContain(request.input.purpose);
      for (const path of request.input.secrets as string[])
        expect(await row.innerText()).toContain(path);
    }
    for (const id of [remembered.id, later.id]) {
      const row = page.locator(`[data-approval="${id}"]`);
      expect(await row.count()).toBe(1);
      expect(await row.getByRole('button').count()).toBe(0);
      expect(
        await row.getByRole('link', { name: 'Review', exact: true }).count(),
      ).toBe(0);
    }
    expect(await page.getByRole('button', { name: /^End/ }).count()).toBe(0);
    expect(
      await page.getByRole('link', { name: 'End', exact: true }).count(),
    ).toBe(0);
    await expectNoOverflow(page);
    await reviews.first().click();
    await page
      .getByRole('heading', { name: 'Approve this run?', exact: true })
      .waitFor();
  } finally {
    await ui.close();
  }
});

it('E36: both empty lists show Nothing waiting for you and no End or Review action', async () => {
  const ui = await approvalBrowserPage(browser, { width: 390, height: 844 });
  try {
    await ui.page.goto(`${app.origin}/approvals`);
    await expect
      .poll(
        () =>
          ui.page.getByText('Nothing waiting for you', { exact: true }).count(),
        { message: 'Empty Approvals renders the reference empty state' },
      )
      .toBe(1);
    expect(await ui.page.locator('body').innerText()).toContain(
      'When a run needs a secret marked Ask first, the agent shares a link and the request shows up here. Approvals you give for 1 or 12 hours are listed here until they end.',
    );
    expect(
      await ui.page.getByRole('link', { name: 'Review', exact: true }).count(),
    ).toBe(0);
    expect(await ui.page.getByRole('button', { name: /^End/ }).count()).toBe(0);
    await expectNoOverflow(ui.page);
  } finally {
    await ui.close();
  }
});

it('E44: the badge refreshes on open, genuine visibility changes and navigation, with no requests during idle time', async () => {
  const first = await webPending(app);
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  page.setDefaultTimeout(5000);
  const reads: string[] = [];
  page.on('request', (r) => {
    if (r.method() === 'GET' && new URL(r.url()).pathname === '/api/approvals')
      reads.push(r.url());
  });
  const badge = page
    .locator('[data-sidebar="menu-item"]')
    .filter({ has: page.getByRole('link', { name: /^Approvals/ }) })
    .locator('[data-sidebar="menu-badge"]');
  try {
    await page.clock.install({ time: approvalNow });
    await page.clock.setFixedTime(approvalNow);
    await page.goto(app.origin);
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('visible');
    await expect
      .poll(() => badge.count(), {
        message: 'The sidebar renders the pending-count badge on app open',
      })
      .toBe(1);
    await expect
      .poll(() => badge.textContent(), {
        message: 'Opening the app reads the server pending count',
      })
      .toBe('1');
    expect(reads.length).toBeGreaterThan(0);
    await page.waitForLoadState('networkidle');
    const afterOpen = reads.length;
    await webPending(app, { purpose: 'created while the owner is idle' });
    // runFor executes every due interval: a periodic poll cannot hide behind fastForward.
    await page.clock.setSystemTime(approvalNow);
    await page.clock.runFor(120_000);
    expect(
      reads,
      'No periodic pending-count requests while the visible tab idles',
    ).toHaveLength(afterOpen);
    expect(await badge.textContent()).toBe('1');
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    await page.clock.runFor(120_000);
    expect(reads, 'No pending-count requests while hidden').toHaveLength(
      afterOpen,
    );
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('visible');
    await expect.poll(() => badge.textContent()).toBe('2');
    expect(reads.length).toBeGreaterThan(afterOpen);
    expect((await decide(app, first.id, 'deny')).status).toBe(200);
    const afterVisible = reads.length;
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await expect.poll(() => badge.textContent()).toBe('1');
    expect(reads.length).toBeGreaterThan(afterVisible);
    await page.waitForLoadState('networkidle');
    const afterNavigation = reads.length;
    await page.clock.runFor(120_000);
    expect(reads, 'Navigation does not start a polling loop').toHaveLength(
      afterNavigation,
    );
    await other.close();
  } finally {
    await observeBrowserPage(page);
    await visible.close();
  }
});
