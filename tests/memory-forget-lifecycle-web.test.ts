import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryId } from './support/memory.ts';
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

it('starting another forget retires settled forgets from the infinite-lived mutation cache', async () => {
  const visit = await forgetPage(browser);
  const gate = deferred();
  const arrived = deferred();
  try {
    const { page } = visit;
    await openForget(page);
    await confirmForget(page);
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    const queries = await memoryQueries(page);
    try {
      expect(
        await queries.evaluate((client) =>
          client
            .getMutationCache()
            .findAll({ mutationKey: ['memory-write'] })
            .map((mutation) => mutation.state.status),
        ),
      ).toEqual(['success']);
      await openForget(page);
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        arrived.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
      await confirmForget(page);
      await arrived.promise;
      expect(
        await queries.evaluate((client) =>
          client
            .getMutationCache()
            .findAll({ mutationKey: ['memory-write'] })
            .map((mutation) => ({
              status: mutation.state.status,
              id: (mutation.state.variables as { id: string }).id,
            })),
        ),
      ).toEqual([{ status: 'pending', id: memoryId(2) }]);
    } finally {
      await queries.dispose();
    }
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('an unconfirmed forget keeps its optimistic removal until an authoritative list or check arrives', async () => {
  const visit = await forgetPage(browser);
  const gate = deferred();
  const arrived = deferred();
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
    );
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.abort(),
    );
    await page.route('**/api/memories?**', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await confirmForget(page);
    await page.getByText('Forget not confirmed', { exact: true }).waitFor();
    await arrived.promise;
    expect(
      await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
    ).toBe(0);
    expect(
      await page.getByRole('article', { name: 'Memory detail' }).innerText(),
    ).not.toContain('Release process');
    const loaded = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/memories',
    );
    gate.resolve();
    await (await loaded).finished();
    await page.locator(`[data-memory-row="${forgottenId}"]`).waitFor();
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('an older Check again cannot repopulate the detail of a newer forget of the same memory', async () => {
  const visit = await forgetPage(browser);
  const checkGate = deferred();
  const checkArrived = deferred();
  const deleteGate = deferred();
  const deleteArrived = deferred();
  let checking = false;
  let deletes = 0;
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      if (++deletes === 1) return route.abort();
      deleteArrived.resolve();
      await deleteGate.promise;
      await route.continue().catch(() => {});
    });
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      if (!checking) return route.abort();
      const response = await route.fetch();
      checkArrived.resolve();
      await checkGate.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await confirmForget(page);
    const unknown = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await unknown.waitFor();
    await page.waitForLoadState('networkidle');
    checking = true;
    await unknown.getByRole('button', { name: 'Check again' }).click();
    await checkArrived.promise;
    // The Check again is read-only; a new version-guarded forget can start.
    await openForget(page, forgottenId);
    await confirmForget(page);
    await deleteArrived.promise;
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
    checkGate.resolve();
    await (await checked).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    const queries = await memoryQueries(page);
    try {
      expect(
        await queries.evaluate(
          (client, id) => client.getQueryData(['memory', id]) ?? null,
          forgottenId,
        ),
      ).toBeNull();
    } finally {
      await queries.dispose();
    }
    await page
      .getByText('Forgetting Release process…', { exact: true })
      .waitFor();
    expect(
      await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
    ).toBe(0);
  } finally {
    checkGate.resolve();
    deleteGate.resolve();
    await visit.close();
  }
});
