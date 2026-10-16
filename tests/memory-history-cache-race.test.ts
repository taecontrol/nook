import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import {
  memoryClient,
  memoryFixture,
  memoryRuntime,
  seedMemories,
} from './support/memory.ts';
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
  const refocus = async (memoryId = id) => {
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    const refreshed = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${memoryId}`,
    );
    await page.bringToFront();
    await refreshed;
    await other.close();
  };
  const update = async (memoryId = id, updatedContent = content) => {
    expect(
      (
        await memoryClient(app, '2026-07-28').call('update', {
          id: memoryId,
          expectedVersion: 1,
          content: updatedContent,
        })
      ).structuredContent,
    ).toMatchObject({ updated: true, version: 2 });
  };
  return {
    app,
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

it('E23/E24: a held old detail cannot replace newer history after the Sheet closes', async () => {
  const visit = await fixture();
  const gate = deferred();
  const arrived = deferred();
  let held = false;
  try {
    const { page } = visit;
    await visit.goto();
    await historyButton(page).waitFor();
    await page.route(`**/api/memories/${id}`, async (route) => {
      const response = await route.fetch();
      if (!held) {
        held = true;
        expect(await response.json()).toMatchObject({ version: 1 });
        arrived.resolve();
        await gate.promise;
      }
      await route.fulfill({ response }).catch(() => {});
    });
    await page.clock.setFixedTime(clock + 30_001);
    const refocus = visit.refocus();
    await arrived.promise;
    await visit.update();
    await historyButton(page).click();
    await page.locator('[data-version-row="2"]').waitFor();
    await currentVersion(page);
    const pane = page.getByRole('article', { name: 'Memory detail' });
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await expect.poll(() => pane.textContent()).toContain('Use pnpm.');
    const delivered = page.waitForResponse(
      (response) => new URL(response.url()).pathname === `/api/memories/${id}`,
    );
    gate.resolve();
    await (await delivered).finished();
    await refocus;
    await page.waitForLoadState('networkidle');
    console.info('old-detail-after-history-close', {
      pane: await pane.textContent(),
      history: await historyButton(page).textContent(),
    });
    expect(await pane.textContent()).toContain('Use pnpm.');
    expect(await historyButton(page).textContent()).toContain('2 versions');
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E23/E24: fresh detail invalidates an older history cache even while that history is otherwise fresh', async () => {
  const visit = await fixture();
  try {
    const { page } = visit;
    const requests: string[] = [];
    const responses: Promise<unknown>[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/versions')) requests.push(request.url());
    });
    page.on('response', (response) => {
      if (response.url().includes('/versions')) responses.push(response.json());
    });
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
    expect(requests).toHaveLength(1);
    await page.mouse.move(0, 0);
    await historyButton(page).hover();
    await expect.poll(() => requests.length).toBe(2);
    await expect.poll(() => responses.length).toBe(2);
    expect(await responses[1]).toMatchObject({
      versions: [{ version: 2 }, { version: 1 }],
    });
    await historyButton(page).click();
    await currentVersion(page);
    expect(requests).toHaveLength(2);
    await page.locator('[data-version-row="2"]').click();
    await page.getByRole('heading', { name: 'Version 2 of 2' }).waitFor();
  } finally {
    await visit.close();
  }
});

it('E23/E24/E26: a browser history jump between memories keeps held-response reconciliation scoped to the selected memory', async () => {
  const visit = await fixture();
  const { page, app } = visit;
  const second = memoryFixture(22, {
    content: '# Secondary package manager\nUse yarn.',
  });
  await seedMemories(app, [second]);
  const firstGate = deferred();
  const secondGate = deferred();
  const firstArrived = deferred();
  const secondArrived = deferred();
  let firstReads = 0;
  let secondReads = 0;
  await page.route('**/api/memories/*/versions*', async (route) => {
    const response = await route.fetch();
    const memoryId = new URL(route.request().url()).pathname.split('/')[3];
    if (memoryId === id && ++firstReads === 1) {
      firstArrived.resolve();
      await firstGate.promise;
    } else if (memoryId === second.id && ++secondReads === 2) {
      secondArrived.resolve();
      await secondGate.promise;
    }
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await visit.goto();
    await page.locator(`[data-memory-row="${second.id}"]`).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('memory'))
      .toBe(second.id);
    await historyButton(page).click();
    await page.locator('[data-version-row="1"]').waitFor();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await expect.poll(() => page.getByRole('dialog').count()).toBe(0);
    await page.locator(`[data-memory-row="${id}"]`).click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('memory'))
      .toBe(id);
    await historyButton(page).click();
    await firstArrived.promise;
    await visit.update();
    await page.clock.setFixedTime(clock + 30_001);
    await visit.refocus();
    await expect
      .poll(() => page.locator('[data-memory-history]').textContent())
      .toContain('2 versions');
    firstGate.resolve();
    await currentVersion(page);
    await page.clock.setFixedTime(clock + 60_002);
    // Select the prior open Sheet entry, as the browser's Back menu allows.
    await page.evaluate(() => window.history.go(-3));
    await secondArrived.promise;
    await visit.update(
      second.id,
      '# Secondary package manager\nUse pnpm with a frozen lockfile.',
    );
    await page.clock.setFixedTime(clock + 90_003);
    await visit.refocus(second.id);
    await expect
      .poll(() => page.locator('[data-memory-history]').textContent())
      .toContain('2 versions');
    secondGate.resolve();
    await expect
      .poll(() => page.locator('[data-version-row="2"]').count())
      .toBe(1);
    await currentVersion(page);
  } finally {
    firstGate.resolve();
    secondGate.resolve();
    await visit.close();
  }
});

it('E23/E24: a held old history response cannot overwrite a newer detail or leave history loading forever', async () => {
  const gate = deferred();
  const arrived = deferred();
  const currentGate = deferred();
  let refetched = false;
  const visit = await fixture('&history=1');
  let first = true;
  await visit.page.route('**/api/memories/*/versions*', async (route) => {
    const response = await route.fetch();
    if (first) {
      first = false;
      arrived.resolve();
      await gate.promise;
    } else {
      refetched = true;
      await currentGate.promise;
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
    await expect.poll(() => refetched).toBe(true);
    await expect
      .poll(() => page.getByRole('status', { name: 'Loading history' }).count())
      .toBe(1);
    expect(await page.locator('[data-version-row]').count()).toBe(0);
    currentGate.resolve();
    await currentVersion(page);
  } finally {
    gate.resolve();
    currentGate.resolve();
    await visit.close();
  }
});
