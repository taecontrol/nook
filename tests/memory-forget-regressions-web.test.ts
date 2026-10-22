import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { access, accessFixture } from './support/access.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryFixture,
  memoryId,
  memoryRows,
  typicalMemories,
} from './support/memory.ts';
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

const detail = (page: Page) =>
  page.getByRole('article', { name: 'Memory detail' });
const rendered = (page: Page) =>
  page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );

it.each([
  { destination: 'Vault', holdRoute: false },
  { destination: 'Vault', holdRoute: true },
  { destination: 'me', holdRoute: false },
])(
  'E20/E21: late forget failure preserves a later navigation to $destination; held route=$holdRoute',
  async ({ destination, holdRoute }) => {
    const vaultGate = deferred();
    const vaultArrived = deferred();
    const gate = deferred();
    const arrived = deferred();
    const errors: string[] = [];
    const anotherBucket = destination === 'me';
    const visit = await forgetPage(browser, {
      seeds: anotherBucket
        ? [typicalMemories[0], typicalMemories[5]]
        : [
            memoryFixture(1, {
              bucket: 'work/acme/api',
              content: '# Release process\nOnly memory.',
            }),
          ],
      start: anotherBucket
        ? '/memory?bucket=me'
        : `/memory?bucket=work/acme/api&scope=bucket&memory=${forgottenId}`,
      configure: async (page) => {
        if (holdRoute)
          await page.route('**/vault-page-*.js', async (route) => {
            vaultArrived.resolve();
            await vaultGate.promise;
            await route.continue().catch(() => {});
          });
        page.on('pageerror', (error) => errors.push(error.message));
        await page.route(
          '**/api/memories/*?expectedVersion=*',
          async (route) => {
            arrived.resolve();
            await gate.promise;
            await route
              .fulfill({ status: 403, body: 'Access denied' })
              .catch(() => {});
          },
        );
      },
    });
    try {
      const { page } = visit;
      if (anotherBucket) {
        // Prime the destination so navigating there during the write needs no read.
        await detail(page)
          .getByRole('heading', { name: 'Prefer pnpm', exact: true })
          .waitFor();
        await page.locator('[data-path="work/acme"]').getByRole('link').click();
      }
      await detail(page)
        .getByRole('heading', { name: 'Release process', exact: true })
        .waitFor();
      await openForget(page);
      await confirmForget(page);
      await arrived.promise;
      await page
        .getByText('Forgetting Release process…', { exact: true })
        .waitFor();
      expect(await memoryRows(page).count()).toBe(anotherBucket ? 1 : 0);
      if (anotherBucket) {
        await page.locator('[data-path="me"]').getByRole('link').click();
        await detail(page)
          .getByRole('heading', { name: 'Prefer pnpm', exact: true })
          .waitFor();
      } else {
        await page.getByRole('link', { name: 'Vault', exact: true }).click();
        await expect.poll(() => new URL(page.url()).pathname).toBe('/vault');
      }
      if (holdRoute) await vaultArrived.promise;
      const rejection = page.waitForResponse(
        (response) => response.request().method() === 'DELETE',
      );
      gate.resolve();
      const response = await rejection;
      expect(response.status()).toBe(403);
      await response.finished();
      if (anotherBucket) {
        const queries = await memoryQueries(page);
        try {
          await expect
            .poll(() =>
              queries.evaluate(
                (client) =>
                  client
                    .getMutationCache()
                    .findAll({ mutationKey: ['memory-write'] })
                    .at(-1)?.state.status,
              ),
            )
            .toBe('error');
        } finally {
          await queries.dispose();
        }
      }
      await rendered(page);
      vaultGate.resolve();
      if (anotherBucket) {
        const location = new URL(page.url());
        expect(location.pathname).toBe('/memory');
        expect(location.searchParams.get('bucket')).toBe('me');
        expect(location.searchParams.get('memory')).toBe(memoryId(6));
        await detail(page)
          .getByRole('heading', { name: 'Prefer pnpm', exact: true })
          .waitFor();
      } else {
        await page.waitForLoadState('networkidle');
        expect(new URL(page.url()).pathname).toBe('/vault');
        await page
          .getByRole('heading', { name: 'Vault', exact: true })
          .waitFor();
      }
      expect(errors).toEqual([]);
    } finally {
      vaultGate.resolve();
      gate.resolve();
      await visit.close();
    }
  },
);

it('E18/E20: an older Check again response preserves a second memory forget progress', async () => {
  const checkGate = deferred();
  const checkArrived = deferred();
  const deleteGate = deferred();
  const deleteArrived = deferred();
  const visit = await forgetPage(browser);
  let reads = 0;
  try {
    const { page } = visit;
    await detail(page).waitFor();
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      if (new URL(route.request().url()).pathname.endsWith(forgottenId)) {
        const response = await route.fetch();
        expect(response.status()).toBe(204);
        await route.abort();
      } else {
        deleteArrived.resolve();
        await deleteGate.promise;
        await route.continue().catch(() => {});
      }
    });
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(404);
      if (++reads === 1) {
        // Lose the authoritative outcome read after the real DELETE committed.
        await route.abort();
        return;
      }
      checkArrived.resolve();
      await checkGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await confirmForget(page);
    const unconfirmed = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await unconfirmed.waitFor();
    await unconfirmed.getByRole('button', { name: 'Check again' }).click();
    await checkArrived.promise;
    await openForget(page, memoryId(2));
    await confirmForget(page);
    await deleteArrived.promise;
    const progress = page.getByText('Forgetting Acme API deployment…', {
      exact: true,
    });
    await progress.waitFor();
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
    checkGate.resolve();
    await (await checked).finished();
    // Let the delivered read and its React update finish while DELETE B is held.
    await rendered(page);
    expect(await progress.count()).toBe(1);
    deleteGate.resolve();
    await page
      .getByText('Forgot Acme API deployment', { exact: true })
      .waitFor();
  } finally {
    checkGate.resolve();
    deleteGate.resolve();
    await visit.close();
  }
});

it('E18/E24: forgetting the last loaded row keeps Load more usable during recovery', async () => {
  const recoveryGate = deferred();
  const recoveryArrived = deferred();
  const visit = await forgetPage(browser, {
    seeds: [...typicalMemories, ...manyMemories],
  });
  try {
    const { page } = visit;
    await expect.poll(() => memoryRows(page).count()).toBe(25);
    const boundary = await memoryRows(page)
      .nth(24)
      .getAttribute('data-memory-row');
    expect(boundary).not.toBeNull();
    await page.route('**/api/memories?*', async (route) => {
      if (new URL(route.request().url()).searchParams.has('cursor')) {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      recoveryArrived.resolve();
      await recoveryGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await openForget(page, boundary ?? '');
    await confirmForget(page);
    await page.getByText(/^Forgot /).waitFor();
    await recoveryArrived.promise;
    const more = page.getByRole('button', { name: 'Load more', exact: true });
    // Waiting for cursor recovery is also a valid way to protect pagination.
    if (await more.isDisabled()) recoveryGate.resolve();
    const next = page.waitForResponse((response) => {
      const url = new URL(response.url());
      return url.pathname === '/api/memories' && url.searchParams.has('cursor');
    });
    await more.click();
    await (await next).finished();
    await rendered(page);
    const error = page.getByText('Could not load memories', { exact: true });
    expect(await error.count()).toBe(0);
    recoveryGate.resolve();
    await expect
      .poll(() => memoryRows(page).count())
      .toBeGreaterThanOrEqual(49);
    expect(await page.locator(`[data-memory-row="${boundary}"]`).count()).toBe(
      0,
    );
  } finally {
    recoveryGate.resolve();
    await visit.close();
  }
});

it.each([
  { status: 401, expected: 'Your owner session expired' },
  { status: 403, expected: 'Only this installation’s owner can' },
])(
  'E20: a genuine $status forget rejection preserves its recovery reason',
  async ({ status, expected }) => {
    const visit = await forgetPage(browser);
    try {
      const { page, app } = visit;
      await detail(page).waitFor();
      await openForget(page);
      if (status === 401) {
        await app.setBindings({ LOCAL_ORIGIN: app.origin });
      } else {
        // Authenticate a genuine synthetic Access identity that is not the owner.
        const issuer = await accessFixture();
        await app.setBindings(access, {
          outboundService: issuer.outboundService,
        });
        await page.setExtraHTTPHeaders({
          'Cf-Access-Jwt-Assertion': await issuer.assertion({
            email: 'another-owner@nook.test',
          }),
        });
      }
      const rejected = page.waitForResponse(
        (response) => response.request().method() === 'DELETE',
      );
      await confirmForget(page);
      const response = await rejected;
      expect(response.status()).toBe(status);
      expect(await response.json()).toMatchObject({
        _tag: status === 401 ? 'Unauthorized' : 'Forbidden',
      });
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Not forgotten' });
      await alert.waitFor();
      const copy = await alert.innerText();
      expect(copy).toContain(expected);
      expect(copy).not.toContain('(503)');
    } finally {
      await visit.close();
    }
  },
);
