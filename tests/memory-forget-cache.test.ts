import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryId,
  memoryRows,
  memoryRuntime,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import {
  confirmForget,
  forgottenId,
  openForget,
  uniqueTerm,
  versionThree,
} from './support/memory-forget.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

it.each([false, true])(
  'E18/E20/E24: all cached pages/scopes/searches stay removed through real tab refocus; rollback=%s',
  async (rollback) => {
    const app = await memoryRuntime();
    const visible = await visibilityBrowser();
    const { page, context } = visible;
    page.setDefaultTimeout(5000);
    const gate = deferred();
    const arrived = deferred();
    const oldRead = deferred();
    const oldArrived = deferred();
    const oldDelivered = deferred();
    const recovery = deferred();
    let recovering = false;
    let guardedReads = 0;
    let pending = false;
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (
        pending &&
        request.method() === 'GET' &&
        path.startsWith('/api/memories') &&
        path !== `/api/memories/${memoryId(102)}`
      )
        guardedReads++;
    });
    try {
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.clock.setFixedTime(new Date('2026-10-14T15:00:00Z'));
      await seedMemories(app, [...typicalMemories, ...manyMemories]);
      await versionThree(app);
      await page.goto(
        `${app.origin}/memory?bucket=work/acme&memory=${forgottenId}&scope=bucket`,
      );
      await page.getByRole('button', { name: /History.*3 versions/ }).click();
      await page.locator('[data-version-row="1"]').waitFor();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Include inherited', exact: true })
        .click();
      await expect.poll(() => memoryRows(page).count()).toBe(25);
      await page
        .getByRole('button', { name: 'Load more', exact: true })
        .click();
      await expect.poll(() => memoryRows(page).count()).toBe(50);
      const search = page.getByRole('textbox', {
        name: 'Search memories visible in work/acme',
      });
      await search.fill(uniqueTerm);
      await search.press('Enter');
      await page.locator(`[data-search-result="${forgottenId}"]`).waitFor();
      await page
        .locator('search')
        .getByRole('button', { name: 'Clear search' })
        .click();
      await expect.poll(() => memoryRows(page).count()).toBe(50);
      await page.locator(`[data-memory-row="${forgottenId}"]`).click();
      await page
        .getByRole('article', { name: 'Memory detail' })
        .getByRole('heading', { name: 'Release process', exact: true })
        .waitFor();
      await page.locator(`[data-memory-row="${memoryId(2)}"]`).click();
      await page
        .getByRole('article', { name: 'Memory detail' })
        .getByRole('heading', { name: 'Acme API deployment', exact: true })
        .waitFor();
      await page.locator(`[data-memory-row="${forgottenId}"]`).click();
      await page
        .getByRole('article', { name: 'Memory detail' })
        .getByRole('heading', { name: 'Release process', exact: true })
        .waitFor();
      let held = false;
      await page.route('**/api/memories?*', async (route) => {
        if (held) {
          await route.continue();
          return;
        }
        held = true;
        const response = await route.fetch();
        oldArrived.resolve();
        await oldRead.promise;
        await route.fulfill({ response }).catch(() => {});
        oldDelivered.resolve();
      });
      for (const pattern of [
        '**/api/memories?*',
        '**/api/memories/search?*',
        '**/api/memories/counts',
      ]) {
        await page.route(pattern, async (route) => {
          if (!recovering) {
            await route.fallback();
            return;
          }
          const response = await route.fetch();
          await recovery.promise;
          await route.fulfill({ response }).catch(() => {});
        });
      }
      const background = await context.newPage();
      await background.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('hidden');
      await page.bringToFront();
      await oldArrived.promise;
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        arrived.resolve();
        await gate.promise;
        if (rollback)
          await route
            .fulfill({ status: 403, body: 'Access denied' })
            .catch(() => {});
        else await route.continue().catch(() => {});
      });
      await openForget(page);
      pending = true;
      await confirmForget(page);
      await arrived.promise;
      await page
        .getByText('Forgetting Release process…', { exact: true })
        .waitFor();
      oldRead.resolve();
      await oldDelivered.promise;
      await page
        .getByRole('article', { name: 'Memory detail' })
        .getByRole('heading', {
          name: 'Review the migration before promoting the API',
          exact: true,
        })
        .waitFor();
      expect(
        await page
          .getByRole('button', { name: 'Load more', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page.goBack();
      await page.goBack();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('memory'))
        .toBe(forgottenId);
      await page
        .getByRole('status', { name: 'Loading memory', exact: true })
        .waitFor();
      expect(
        await page.getByRole('article', { name: 'Memory detail' }).count(),
      ).toBe(0);
      expect(
        await page.getByRole('button', { name: /History.*versions?/ }).count(),
      ).toBe(0);
      await page.goForward();
      await page.goForward();
      await expect
        .poll(() => new URL(page.url()).searchParams.get('memory'))
        .toBe(memoryId(102));
      await page
        .getByRole('button', { name: 'Only this bucket', exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: 'Only this bucket', exact: true })
            .getAttribute('aria-pressed'),
        )
        .toBe('true');
      expect(
        await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
      ).toBe(0);
      await page
        .getByRole('button', { name: 'Include inherited', exact: true })
        .click();
      await expect
        .poll(() =>
          page
            .getByRole('button', { name: 'Include inherited', exact: true })
            .getAttribute('aria-pressed'),
        )
        .toBe('true');
      expect(
        await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
      ).toBe(0);
      await search.fill(uniqueTerm);
      await search.press('Enter');
      await page.locator('[data-search-results]').waitFor();
      expect(
        await page
          .getByRole('alert')
          .filter({ hasText: 'Exact words only' })
          .getByRole('button', { name: 'Try again', exact: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page.locator(`[data-search-result="${forgottenId}"]`).count(),
      ).toBe(0);
      const other = await context.newPage();
      await other.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('hidden');
      await page.bringToFront();
      await expect
        .poll(() => page.evaluate(() => document.visibilityState))
        .toBe('visible');
      expect(guardedReads).toBe(0);
      expect(
        await page.locator(`[data-search-result="${forgottenId}"]`).count(),
      ).toBe(0);
      pending = false;
      recovering = rollback;
      gate.resolve();
      await settled(page, rollback);
    } finally {
      pending = false;
      gate.resolve();
      oldRead.resolve();
      recovery.resolve();
      await page.unrouteAll({ behavior: 'ignoreErrors' });
      await observeBrowserPage(page);
      await visible.close();
      await app.close();
    }
  },
);
async function settled(page: import('playwright').Page, rollback: boolean) {
  if (rollback) {
    await page
      .getByRole('alert')
      .filter({ hasText: 'Not forgotten' })
      .waitFor();
    expect(
      await page.locator(`[data-search-result="${forgottenId}"]`).count(),
    ).toBe(1);
    expect(await page.locator('[data-path="work/acme"]').innerText()).toContain(
      '63 memories',
    );
  } else {
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    expect(
      await page.locator(`[data-search-result="${forgottenId}"]`).count(),
    ).toBe(0);
  }
  await page
    .locator('search')
    .getByRole('button', { name: 'Clear search' })
    .click();
  await memoryRows(page).first().waitFor();
  expect(await page.locator(`[data-memory-row="${forgottenId}"]`).count()).toBe(
    rollback ? 1 : 0,
  );
}
