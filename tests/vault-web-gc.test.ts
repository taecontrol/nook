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
async function pendingWrites(
  page: Awaited<ReturnType<typeof vaultPage>>['page'],
) {
  return page.evaluate(() => {
    const element = document.querySelector('#root > *');
    const key = Object.keys(element ?? {}).find((entry) =>
      entry.startsWith('__reactFiber$'),
    );
    type Fiber = {
      return?: Fiber;
      memoizedProps?: { client?: { isMutating(): number } };
    };
    let fiber = key
      ? (element as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (client?.isMutating) return client.isMutating();
      fiber = fiber.return;
    }
    return -1;
  });
}

async function pendingValueMap(
  page: Awaited<ReturnType<typeof vaultPage>>['page'],
) {
  return page.evaluateHandle(() => {
    const element = document.querySelector('#root > *');
    const key = Object.keys(element ?? {}).find((entry) =>
      entry.startsWith('__reactFiber$'),
    );
    type Hook = {
      memoizedState?: { current?: unknown };
      next?: Hook;
    };
    type Fiber = {
      return?: Fiber;
      child?: Fiber;
      sibling?: Fiber;
      memoizedState?: Hook;
      memoizedProps?: {
        client?: {
          getMutationCache(): {
            getAll(): {
              state: { status: string; variables?: { writeId?: string } };
            }[];
          };
        };
      };
    };
    let fiber = key
      ? (element as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (client?.getMutationCache) {
        const writeId = client
          .getMutationCache()
          .getAll()
          .find((mutation) => mutation.state.status === 'pending')?.state
          .variables?.writeId;
        if (!writeId) return null;
        const findMap = (
          node: Fiber | undefined,
        ): Map<unknown, unknown> | null => {
          if (!node) return null;
          let hook = node.memoizedState;
          while (hook) {
            const value = hook.memoizedState?.current;
            if (value instanceof Map && value.has(writeId)) return value;
            hook = hook.next;
          }
          return findMap(node.child) ?? findMap(node.sibling);
        };
        return findMap(fiber.child);
      }
      fiber = fiber.return;
    }
    return null;
  });
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
  let valueMap: Awaited<ReturnType<typeof pendingValueMap>> | undefined;
  try {
    await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
    await page.clock.install({ time: new Date() });
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    expect(await secretRow(page, target).innerText()).toContain('Saving');
    // Native mutation options retain this original Hook after route unmount.
    // Observe its real Map through a handle; no protected value crosses the boundary.
    valueMap = await pendingValueMap(page);
    expect(
      await valueMap.evaluate(
        (value) => value instanceof Map && value.size > 0,
      ),
    ).toBe(true);
    await page
      .getByRole('navigation', { name: 'breadcrumb' })
      .getByRole('link', { name: 'Nook', exact: true })
      .click();
    const initialLists = listCount(visit);
    await page.clock.fastForward(31_001);
    await page
      .getByRole('region', { name: 'Tools', exact: true })
      .getByRole('link', { name: /Vault/ })
      .hover();
    await page.clock.runFor(100);
    expect(listCount(visit)).toBe(initialLists);
    await page
      .getByRole('region', { name: 'Tools', exact: true })
      .getByRole('link', { name: /Vault/ })
      .click();
    await page
      .getByRole('list', { name: 'Buckets', exact: true })
      .locator('[data-path="work/acme"]')
      .getByRole('link')
      .click();
    expect(await secretRow(page, target).innerText()).toContain('Saving');
    await page.evaluate(() =>
      window.dispatchEvent(new Event('visibilitychange')),
    );
    await page.clock.runFor(100);
    expect(listCount(visit)).toBe(initialLists);
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
    // Requests reaching the server do not prove their final replies settled.
    await expect.poll(() => pendingWrites(page)).toBe(0);
    expect(
      await valueMap.evaluate(
        (value) => value instanceof Map && value.size === 0,
      ),
    ).toBe(true);
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
    try {
      await valueMap?.dispose();
    } finally {
      await visit.close();
    }
  }
});

it.each([
  { label: 'desktop', viewport: { width: 1440, height: 900 } },
  { label: 'phone', viewport: { width: 390, height: 844 } },
])(
  'E21: an unconfirmed submission survives route unmount and GC until a successful list, including a failed remount list on $label',
  async ({ viewport }) => {
    let failList = false;
    const visit = await vaultPage(browser, {
      viewport,
      configure: async (page) => {
        await page.route('**/api/secrets', (route) =>
          route.request().method() === 'POST' || failList
            ? route.fulfill({
                status: 503,
                json: { _tag: 'ServiceUnavailable' },
              })
            : route.continue(),
        );
      },
    });
    const { page } = visit;
    const loadFailure = page
      .getByRole('alert')
      .filter({ hasText: 'Couldn’t load secrets' });
    const cachedMessage =
      'Secret metadata could not be refreshed. Previously loaded data is still shown.';
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
      const failedList = page
        .waitForResponse(
          (response) =>
            response.request().method() === 'GET' &&
            new URL(response.url()).pathname === '/api/secrets' &&
            response.status() === 503,
        )
        .catch(() => undefined);
      await page
        .getByRole('region', { name: 'Tools', exact: true })
        .getByRole('link', { name: /Vault/ })
        .click();
      const response = await failedList;
      expect(response?.status()).toBe(503);
      await response?.finished();
      expect(
        await page
          .getByRole('list', { name: 'Buckets', exact: true })
          .locator('[data-path="work/acme"]')
          .innerText(),
      ).toMatch(/5\s*secrets/);
      // Cached failures must be visible on the phone bucket list before drill-in.
      await loadFailure.waitFor({ state: 'visible' });
      expect(await loadFailure.innerText()).toContain(cachedMessage);
      await page
        .getByRole('list', { name: 'Buckets', exact: true })
        .locator('[data-path="work/acme"]')
        .getByRole('link')
        .click();
      await loadFailure.waitFor({ state: 'visible' });
      expect(await loadFailure.innerText()).toContain('(503)');
      expect(await secretRow(page, 'work/acme/STRIPE_KEY').count()).toBe(1);
      expect(
        await page
          .getByRole('region', { name: 'Stored here' })
          .locator('[data-secret]')
          .count(),
      ).toBe(5);
      expect(await loadFailure.innerText()).toContain(cachedMessage);
      expect(await feedback(page).innerText()).toContain('could not confirm');
      expect(await secretRow(page, target).innerText()).toContain('Confirming');
      expect(
        await privateClientState(page, ['synthetic-browser-vault-value']),
      ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      failList = false;
      await feedback(page)
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await feedback(page)
        .filter({ hasText: 'is no longer stored.' })
        .waitFor();
      expect(await secretRow(page, target).count()).toBe(0);
    } finally {
      await visit.close();
    }
  },
);
