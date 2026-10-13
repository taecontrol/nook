import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryClient, memoryRuntime } from './support/memory.ts';
import { memories, scenarios, seedHistory } from './support/memory-history.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

const id = memories[1].id;
const content = '# Current package manager\nUse pnpm.';
const clock = new Date('2026-10-13T16:00:00Z').getTime();
const historyButton = (page: Page) =>
  page.getByRole('button', { name: /History.*versions?/ });
async function fixture(state = '') {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  await page.clock.setFixedTime(clock);
  await page.setViewportSize({ width: 1440, height: 900 });
  await seedHistory(app);
  const close = async () => {
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  };
  const refocus = async () => {
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    const refreshed = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/memories/${id}`,
    );
    await page.bringToFront();
    await refreshed;
    await other.close();
  };
  const update = async () => {
    expect(
      (
        await memoryClient(app, '2026-07-28').call('update', {
          id,
          expectedVersion: 1,
          content,
        })
      ).structuredContent,
    ).toMatchObject({ updated: true, version: 2 });
  };
  return {
    page,
    close,
    update,
    refocus,
    goto: () =>
      page.goto(`${app.origin}${scenarios['never-updated'].start}${state}`),
  };
}
async function currentVersion(page: Page) {
  await page.locator('[data-version-row="2"]').waitFor();
  expect(await page.locator('[data-version-row="2"]').textContent()).toContain(
    'Current',
  );
  expect(
    await page.locator('[data-version-row="1"]').textContent(),
  ).not.toContain('Current');
}

it('E23/E24: fresh detail invalidates an older history cache even while that history is otherwise fresh', async () => {
  const visit = await fixture();
  try {
    const { page } = visit;
    await visit.goto();
    await historyButton(page).waitFor();
    await page.clock.setFixedTime(clock + 10_000);
    await historyButton(page).click();
    await page.locator('[data-version-row="1"]').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await visit.update();
    await page.clock.setFixedTime(clock + 30_001);
    await visit.refocus();
    await expect
      .poll(() => historyButton(page).textContent())
      .toContain('2 versions');
    await historyButton(page).click();
    await currentVersion(page);
    await page.locator('[data-version-row="2"]').click();
    await page.getByRole('heading', { name: 'Version 2 of 2' }).waitFor();
  } finally {
    await visit.close();
  }
});

it('E23/E24: a held old history response cannot overwrite a newer detail or leave history loading forever', async () => {
  const gate = deferred();
  const arrived = deferred();
  const visit = await fixture('&history=1');
  let first = true;
  await visit.page.route('**/api/memories/*/versions*', async (route) => {
    const response = await route.fetch();
    if (first) {
      first = false;
      arrived.resolve();
      await gate.promise;
    }
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    const { page } = visit;
    await visit.goto();
    await arrived.promise;
    await page.locator('[data-memory-history]').waitFor({ state: 'attached' });
    await visit.update();
    await page.clock.setFixedTime(clock + 30_001);
    await visit.refocus();
    await expect
      .poll(() => page.locator('[data-memory-history]').textContent())
      .toContain('2 versions');
    gate.resolve();
    await currentVersion(page);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
