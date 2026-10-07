import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { listSecrets } from './support/vault.ts';
import {
  createDraft,
  privateClientState,
  secretRow,
  vaultPage,
} from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it.each([
  { label: 'desktop', viewport: { width: 1440, height: 900 } },
  { label: 'phone', viewport: { width: 390, height: 844 } },
])(
  'E21: a manual cached-error retry cannot predate a pending commit on $label',
  async ({ label, viewport }) => {
    const gate = deferred();
    let failList = false;
    let attempts = 0;
    let committed = false;
    const visit = await vaultPage(browser, {
      viewport,
      configure: async (page) => {
        await page.route('**/api/secrets', async (route) => {
          if (route.request().method() === 'GET')
            return failList
              ? route.fulfill({
                  status: 503,
                  json: { _tag: 'ServiceUnavailable' },
                })
              : route.continue();
          await gate.promise;
          const response = await route.fetch();
          attempts++;
          if (attempts === 1) {
            expect(response.status()).toBe(201);
            committed = true;
          }
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        });
      },
    });
    const { page } = visit;
    const loadFailure = page
      .getByRole('alert')
      .filter({ hasText: 'Couldn’t load secrets' });
    const listCount = () =>
      visit.requests.filter(
        (request) =>
          request.method === 'GET' && request.path === '/api/secrets',
      ).length;
    try {
      await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
      await page.clock.install({ time: new Date() });
      failList = true;
      const failed = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/api/secrets' &&
            response.status() === 503,
        )
        .catch(() => undefined);
      await page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      const response = await failed;
      expect(response?.status()).toBe(503);
      await response?.finished();
      await loadFailure.waitFor();
      const sheet = await createDraft(page);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      expect(
        await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
      ).toContain('Saving');
      if (label === 'phone')
        await page
          .getByRole('link', { name: 'All buckets', exact: true })
          .click();
      failList = false;
      const lists = listCount();
      const retry = loadFailure.getByRole('button', {
        name: 'Try again',
        exact: true,
      });
      // A real pointer click cannot start a list before the held write settles.
      // force skips Playwright's disabled wait, preserving the native Button behavior.
      await retry.click({ force: true });
      await page.clock.runFor(100);
      expect(listCount()).toBe(lists);
      expect(await retry.isEnabled()).toBe(false);
      gate.resolve();
      await expect.poll(() => attempts).toBe(3);
      expect(committed).toBe(true);
      expect(
        (await listSecrets(visit.app)).some(
          (secret) => secret.path === 'work/acme/RESEND_API_KEY',
        ),
      ).toBe(true);
      const feedback = page.getByRole('alert').filter({
        has: page.getByRole('button', { name: 'Dismiss', exact: true }),
      });
      await expect
        .poll(() => feedback.innerText())
        .toContain('could not confirm');
      expect(
        await privateClientState(page, [
          'synthetic-browser-vault-value',
          ...visit.values,
        ]),
      ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      if (label === 'phone')
        await page
          .getByRole('list', { name: 'Buckets', exact: true })
          .locator('[data-path="work/acme"]')
          .getByRole('link')
          .click();
      expect(
        await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
      ).toContain('Confirming');
      await loadFailure
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await feedback
        .filter({ has: page.getByText('Secret saved', { exact: true }) })
        .waitFor();
      expect(
        await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
      ).not.toContain('Confirming');
      expect(listCount()).toBe(lists + 1);
      expect(attempts).toBe(3);
    } finally {
      gate.resolve();
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } finally {
        await visit.close();
      }
    }
  },
);
