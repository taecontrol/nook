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
const target = 'work/acme/RESEND_API_KEY';
const feedback = (page: Awaited<ReturnType<typeof vaultPage>>['page']) =>
  page.getByRole('alert').filter({
    has: page.getByRole('button', { name: 'Dismiss', exact: true }),
  });
function listCount(visit: Awaited<ReturnType<typeof vaultPage>>) {
  return visit.requests.filter(
    (request) => request.method === 'GET' && request.path === '/api/secrets',
  ).length;
}

it.each([false, true])(
  'E21: an older unconfirmed submission (committed: %s) survives garbage collection after a later submission',
  async (committed) => {
    let attempts = 0;
    const visit = await vaultPage(browser, {
      configure: async (page) => {
        await page.route('**/api/secrets', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          if (++attempts === 1 && committed)
            expect((await route.fetch()).status()).toBe(201);
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        });
      },
    });
    const { page } = visit;
    try {
      await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
      await page.clock.install({ time: new Date() });
      for (const name of ['RESEND_API_KEY', 'SECOND_KEY']) {
        const sheet = await createDraft(page, { name });
        await sheet
          .getByRole('button', { name: 'Save secret', exact: true })
          .click();
        await feedback(page)
          .filter({
            hasText: `Nook could not confirm whether work/acme/${name} was stored.`,
          })
          .waitFor();
        expect(
          await secretRow(page, `work/acme/${name}`).innerText(),
        ).toContain('Confirming');
      }
      expect(attempts).toBe(6);
      expect(
        (await listSecrets(visit.app)).some((row) => row.path === target),
      ).toBe(committed);
      const lists = listCount(visit);
      await page.clock.fastForward(300_001);
      expect(listCount(visit)).toBe(lists);
      expect(await secretRow(page, target).count()).toBe(1);
      expect(await secretRow(page, target).innerText()).toContain('Confirming');
      expect(
        await privateClientState(page, ['synthetic-browser-vault-value']),
      ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      await feedback(page)
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await feedback(page)
        .filter({ hasText: 'Current secret state' })
        .waitFor();
      expect(await secretRow(page, target).count()).toBe(committed ? 1 : 0);
      if (committed)
        expect(await secretRow(page, target).innerText()).not.toContain(
          'Confirming',
        );
      expect(await secretRow(page, 'work/acme/SECOND_KEY').count()).toBe(0);
      expect(attempts).toBe(6);
    } finally {
      await visit.close();
    }
  },
);

it('E21: the first successful list after route unmount and the query GC interval reconciles the old submission', async () => {
  const gate = deferred();
  const visit = await vaultPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        await gate.promise;
        return route.fulfill({
          status: 503,
          json: { _tag: 'ServiceUnavailable' },
        });
      });
    },
  });
  const { page } = visit;
  try {
    await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
    await page.clock.install({ time: new Date() });
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    expect(await secretRow(page, target).innerText()).toContain('Saving');
    await page
      .getByRole('navigation', { name: 'breadcrumb' })
      .getByRole('link', { name: 'Nook', exact: true })
      .click();
    // Pending mutations survive the native GC interval, while an unobserved
    // query would be discarded and restart its successful-list counter at zero.
    await page.clock.fastForward(300_001);
    gate.resolve();
    await expect
      .poll(
        () =>
          visit.requests.filter((request) => request.method === 'POST').length,
      )
      .toBe(3);
    const lists = listCount(visit);
    await page
      .getByRole('link', { name: 'Vault', exact: true })
      .first()
      .click();
    await expect.poll(() => listCount(visit)).toBe(lists + 1);
    await page
      .getByRole('list', { name: 'Buckets', exact: true })
      .locator('[data-path="work/acme"]')
      .getByRole('link')
      .click();
    await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
    await feedback(page).filter({ hasText: 'is no longer stored.' }).waitFor();
    expect(await secretRow(page, target).count()).toBe(0);
    expect(
      await privateClientState(page, ['synthetic-browser-vault-value']),
    ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E21: an unconfirmed submission survives route unmount and GC until a successful list, including a failed remount list', async () => {
  let failList = false;
  const visit = await vaultPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', (route) =>
        route.request().method() === 'POST' || failList
          ? route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
          : route.continue(),
      );
    },
  });
  const { page } = visit;
  try {
    await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
    await page.clock.install({ time: new Date() });
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await feedback(page).filter({ hasText: 'could not confirm' }).waitFor();
    failList = true;
    await page
      .getByRole('navigation', { name: 'breadcrumb' })
      .getByRole('link', { name: 'Nook', exact: true })
      .click();
    await page.clock.fastForward(300_001);
    await page
      .getByRole('link', { name: 'Vault', exact: true })
      .first()
      .click();
    await page
      .getByRole('list', { name: 'Buckets', exact: true })
      .locator('[data-path="work/acme"]')
      .getByRole('link')
      .click();
    await page.getByText('Couldn’t load secrets', { exact: true }).waitFor();
    expect(await feedback(page).innerText()).toContain('could not confirm');
    expect(await secretRow(page, target).innerText()).toContain('Confirming');
    expect(
      await privateClientState(page, ['synthetic-browser-vault-value']),
    ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    failList = false;
    await feedback(page)
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await feedback(page).filter({ hasText: 'is no longer stored.' }).waitFor();
    expect(await secretRow(page, target).count()).toBe(0);
  } finally {
    await visit.close();
  }
});
