import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { historyPage, memories, seedHistory } from './support/memory-history.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
const sheet = (page: Page) => page.getByRole('dialog');
const history = (page: Page) =>
  page.getByRole('button', { name: /History.*versions?/ });
describe.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])('#12 history at $width px', (viewport) => {
  it.each(['hover', 'focus'] as const)(
    'E22: History counts locally and %s preloads exactly once before opening',
    async (intent) => {
      const requests: string[] = [];
      const visit = await historyPage(browser, {
        viewport,
        configure: async (page) => {
          page.on('request', (r) => {
            if (r.url().includes('/versions')) requests.push(r.url());
          });
        },
      });
      try {
        const { page } = visit;
        await history(page).waitFor();
        expect(
          await page
            .getByRole('article', { name: 'Memory detail' })
            .textContent(),
        ).toContain('Updated');
        expect(requests).toEqual([]);
        if (intent === 'hover') await history(page).hover();
        else await history(page).focus();
        await expect.poll(() => requests.length).toBe(1);
        await history(page).click();
        await page.locator('[data-version-row]').last().waitFor();
        expect(requests).toHaveLength(1);
      } finally {
        await visit.close();
      }
    },
  );
  it('E23/E24/E25: rows have summaries, times and writers; arrows read Markdown and changes mark source and tags', async () => {
    const visit = await historyPage(browser, { viewport, state: '&history=1' });
    try {
      const { page } = visit;
      const rows = page.locator('[data-version-row]');
      await rows.last().waitFor();
      expect(
        await rows.evaluateAll((r) =>
          r.map((n) => n.getAttribute('data-version-row')),
        ),
      ).toEqual(['4', '3', '2', '1']);
      for (const [version, summary] of [
        [4, 'Content · tags +freeze'],
        [3, 'Tags only: +staging'],
        [2, 'Content'],
        [1, 'First version'],
      ])
        expect(
          await rows.filter({ hasText: `Version ${version}` }).textContent(),
        ).toContain(summary);
      expect(await rows.first().textContent()).toContain('Current');
      expect(await rows.nth(2).textContent()).toContain(
        'build-runner-02 · codex-mcp-client 0.162.0',
      );
      expect(
        await rows.first().locator('time').getAttribute('title'),
      ).toBeTruthy();
      expect(await rows.first().getAttribute('data-slot')).toBe('item');
      await rows.nth(2).click();
      await sheet(page)
        .getByRole('heading', { name: 'Version 2 of 4' })
        .waitFor();
      expect(await sheet(page).textContent()).toContain('Working directory');
      expect(await sheet(page).locator('.memory-markdown ol').count()).toBe(1);
      await sheet(page).getByRole('button', { name: 'Show changes' }).click();
      await sheet(page).locator('[data-memory-diff]').waitFor();
      expect(
        await sheet(page).locator('[data-diff-row="add"]').textContent(),
      ).toContain('Added:');
      expect(
        await sheet(page).locator('[data-diff-row="del"]').textContent(),
      ).toContain('Removed:');
      expect(await sheet(page).locator('ins').count()).toBeGreaterThan(0);
      expect(await sheet(page).locator('del').count()).toBeGreaterThan(0);
      await sheet(page).getByRole('button', { name: 'Newer version' }).click();
      await sheet(page)
        .getByText('The content is the same as in version 2.', { exact: true })
        .waitFor();
      expect(
        await sheet(page)
          .getByText('Added tag ', { exact: false })
          .textContent(),
      ).toContain('staging');
      await sheet(page).getByRole('button', { name: 'Older version' }).click();
      await sheet(page).getByRole('button', { name: 'Older version' }).click();
      await sheet(page)
        .getByText('First version, nothing to compare', { exact: true })
        .waitFor();
      expect(
        await sheet(page)
          .getByRole('button', { name: 'Show changes' })
          .isDisabled(),
      ).toBe(true);
    } finally {
      await visit.close();
    }
  });
  it('E25: long unchanged source runs fold with three lines of context and can be revealed', async () => {
    const visit = await historyPage(browser, {
      viewport,
      scenario: 'long',
      state: '&history=1&version=3&changes=1',
    });
    try {
      const { page } = visit;
      const folds = sheet(page).getByRole('button', {
        name: /Show \d+ unchanged lines/,
      });
      await folds.first().waitFor();
      const before = await sheet(page)
        .locator('[data-diff-row="same"]')
        .count();
      const text = await folds.first().textContent();
      const n = Number(text?.match(/\d+/)?.[0]);
      expect(n).toBeGreaterThanOrEqual(8);
      await folds.first().click();
      expect(await sheet(page).locator('[data-diff-row="same"]').count()).toBe(
        before + n,
      );
    } finally {
      await visit.close();
    }
  });
  it.each(['Escape', 'Close', 'overlay'] as const)(
    'E26: reload/Back restore history; %s removes every param and returns focus even on a deep link',
    async (dismiss) => {
      const visit = await historyPage(browser, { viewport });
      try {
        const { page } = visit;
        await history(page).click();
        await page.locator('[data-version-row="2"]').click();
        await sheet(page).getByRole('button', { name: 'Show changes' }).click();
        await page.reload();
        await sheet(page).locator('[data-memory-diff]').waitFor();
        expect(new URL(page.url()).searchParams.get('version')).toBe('2');
        expect(
          await sheet(page)
            .getByRole('button', { name: 'Show changes' })
            .getAttribute('aria-pressed'),
        ).toBe('true');
        await page.goBack();
        await page.locator('[data-version-row="4"]').waitFor();
        await page.goBack();
        await expect.poll(() => sheet(page).count()).toBe(0);
        await page.goto(
          visit.app.origin +
            `/memory?bucket=work/acme&memory=${memories[0].id}&history=1&version=2&changes=1`,
        );
        await sheet(page).locator('[data-memory-diff]').waitFor();
        if (dismiss === 'Escape') await page.keyboard.press('Escape');
        else if (dismiss === 'Close')
          await sheet(page)
            .getByRole('button', { name: 'Close', exact: true })
            .click();
        else if (viewport.width === 390) await page.keyboard.press('Escape');
        else
          await page
            .locator('[data-slot="sheet-overlay"]')
            .click({ position: { x: 10, y: 10 } });
        await expect.poll(() => sheet(page).count()).toBe(0);
        for (const key of ['history', 'version', 'changes'])
          expect(new URL(page.url()).searchParams.has(key)).toBe(false);
        expect(
          await history(page).evaluate((el) => el === document.activeElement),
        ).toBe(true);
        if (viewport.width === 1440) {
          await page.locator(`[data-memory-row="${memories[1].id}"]`).click();
          expect(new URL(page.url()).searchParams.has('history')).toBe(false);
        }
      } finally {
        await visit.close();
      }
    },
  );
  it('E27: genuine delayed history rows reserve their height and retry recovers a failed history read', async () => {
    const gate = deferred();
    let fail = false;
    const visit = await historyPage(browser, {
      viewport,
      state: '&history=1',
      configure: async (page) => {
        await page.route('**/api/memories/*/versions*', async (route) => {
          if (fail)
            return route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: '{"_tag":"ServiceUnavailable"}',
            });
          const response = await route.fetch();
          await gate.promise;
          await route.fulfill({ response }).catch(() => {});
        });
      },
    });
    try {
      const { page } = visit;
      await sheet(page)
        .getByRole('status', { name: 'Loading history' })
        .waitFor();
      const header = await sheet(page)
        .getByRole('heading', { name: 'History' })
        .boundingBox();
      const skeleton = await page
        .locator('[data-history-skeleton-row]')
        .first()
        .boundingBox();
      gate.resolve();
      await page.locator('[data-version-row="4"]').waitFor();
      expect(
        await sheet(page)
          .getByRole('heading', { name: 'History' })
          .boundingBox(),
      ).toEqual(header);
      expect(
        (await page.locator('[data-version-row="4"]').boundingBox())?.height,
      ).toBe(skeleton?.height);
      fail = true;
      await page.reload();
      await sheet(page)
        .getByText('Could not load history', { exact: true })
        .waitFor();
      fail = false;
      await sheet(page).getByRole('button', { name: 'Retry history' }).click();
      await page.locator('[data-version-row="4"]').waitFor();
    } finally {
      gate.resolve();
      await visit.close();
    }
  });
  it.each(['many', 'never-updated', 'inherited', 'long'] as const)(
    'E23/E27: %s history stays usable and has no horizontal overflow',
    async (scenario) => {
      const visit = await historyPage(browser, {
        viewport,
        scenario,
        state: '&history=1',
      });
      try {
        const { page } = visit;
        await page.locator('[data-version-row]').last().waitFor();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(viewport.width);
        expect(
          await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
        if (scenario === 'many') {
          const header = await sheet(page)
            .getByRole('heading', { name: 'History' })
            .boundingBox();
          expect(await page.locator('[data-version-row]').count()).toBe(30);
          await page.locator('[data-version-row="1"]').scrollIntoViewIfNeeded();
          expect(
            await sheet(page)
              .getByRole('heading', { name: 'History' })
              .boundingBox(),
          ).toEqual(header);
        }
        await page.locator('[data-version-row]').first().click();
        await sheet(page)
          .getByRole('heading', { name: /Version \d+ of \d+/ })
          .waitFor();
        expect(
          await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth),
        ).toBe(true);
      } finally {
        await visit.close();
      }
    },
  );
});
it('E28: first-screen Memory JavaScript omits the lazy history sheet and jsdiff modules', async () => {
  const requested: string[] = [];
  const visit = await historyPage(browser, {
    configure: async (page) => {
      page.on('request', (r) => {
        if (r.resourceType() === 'script') requested.push(r.url());
      });
    },
  });
  try {
    const { page } = visit;
    await history(page).waitFor();
    expect(
      requested.some((url) => /memory-history-sheet|memory-diff/.test(url)),
    ).toBe(false);
    await history(page).click();
    await page.locator('[data-version-row="2"]').click();
    await sheet(page).getByRole('button', { name: 'Show changes' }).click();
    await page.locator('[data-memory-diff]').waitFor();
    expect(requested.some((url) => /memory-history-sheet/.test(url))).toBe(
      true,
    );
    expect(requested.some((url) => /memory-diff/.test(url))).toBe(true);
  } finally {
    await visit.close();
  }
});
it('E27: 16 KiB Unicode, six 32-character segments, long names and directories fit a 390 px history version', async () => {
  const bucket = Array.from({ length: 6 }, (_, i) => `${'x'.repeat(31)}${i}`).join('/');
  const fixture = { ...memories[0], id: '00000000-0000-4000-8000-000000009999', bucket, versions: [
    { ...memories[0].versions[0], content: 'é'.repeat(8192), tags: ['removed'], author: { ...memories[0].versions[0].author, principal: { kind: 'machine' as const, id: 'long-name', name: 'long-machine-'.repeat(9) }, workingDirectory: `/${'directory/'.repeat(300)}` } },
    { ...memories[0].versions[1], content: 'ø'.repeat(8192), tags: ['added'] },
  ] };
  const visit = await historyPage(browser, { viewport: { width: 390, height: 844 }, configure: async (page, app) => {
    await seedHistory(app, [fixture]);
    await page.route('**/api/memories/*/versions*', (route) => route.continue());
  } });
  try {
    const { page } = visit;
    await page.goto(`${visit.app.origin}/memory?bucket=${bucket}&memory=${fixture.id}&history=1&version=2&changes=1`);
    await sheet(page).locator('[data-memory-diff]').waitFor();
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(390);
    expect(await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await sheet(page).textContent()).toContain('Removed tag');
    expect(await sheet(page).textContent()).toContain('Added tag');
    await sheet(page).getByRole('button', { name: 'Older version' }).click();
    await sheet(page).getByRole('heading', { name: 'Version 1 of 2' }).waitFor();
    expect(await sheet(page).evaluate((el) => el.scrollWidth <= el.clientWidth)).toBe(true);
  } finally { await visit.close(); }
});
