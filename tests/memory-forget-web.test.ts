import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRows,
  typicalMemories,
} from './support/memory.ts';
import {
  confirmForget,
  forgetDialog,
  forgetPage,
  forgottenId,
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
const row = (page: Page, id = forgottenId) =>
  page.locator(`[data-memory-row="${id}"], [data-search-result="${id}"]`);
const count = (page: Page) => page.locator('[data-path="work/acme"]');
describe.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])('Forget #13 at $width px', (viewport) => {
  it('E18/E22/E24: confirmation removes optimistically, moves the pane, adjusts counts, and persists after reload', async () => {
    const gate = deferred();
    const arrived = deferred();
    const visit = await forgetPage(browser, {
      viewport,
      configure: async (page) => {
        await page.route(
          '**/api/memories/*?expectedVersion=*',
          async (route) => {
            arrived.resolve();
            await gate.promise;
            await route.continue().catch(() => {});
          },
        );
      },
    });
    try {
      const { page } = visit;
      await detail(page).waitFor();
      await openForget(page);
      expect(await forgetDialog(page).textContent()).toContain(
        'all 3 versions',
      );
      expect(await forgetDialog(page).textContent()).toContain('Who loses it');
      expect(await forgetDialog(page).textContent()).toContain(
        'You are forgetting version 3',
      );
      expect(
        await forgetDialog(page)
          .getByRole('button', { name: 'Cancel' })
          .evaluate((el) => document.activeElement === el),
      ).toBe(true);
      await confirmForget(page);
      await arrived.promise;
      await expect.poll(() => row(page).count()).toBe(0);
      await page
        .getByText('Forgetting Release process…', { exact: true })
        .waitFor();
      if (viewport.width > 1000) {
        expect(await count(page).innerText()).toContain('2 memories');
        await detail(page)
          .getByRole('heading', { name: 'Acme API deployment' })
          .waitFor();
      } else expect(new URL(page.url()).searchParams.has('memory')).toBe(false);
      expect(await page.locator('body').textContent()).not.toContain(
        'Forgot Release process',
      );
      gate.resolve();
      await page.getByText('Forgot Release process', { exact: true }).waitFor();
      await page.reload();
      await memoryRows(page).first().waitFor();
      expect(await row(page).count()).toBe(0);
    } finally {
      gate.resolve();
      await visit.close();
    }
  });
  it('E20: 503 restores the row and counts; explicit Try again is the only new request', async () => {
    let fail = true;
    let deletes = 0;
    const visit = await forgetPage(browser, {
      viewport,
      configure: async (page, app) => {
        await (await app.mf.getD1Database('DB'))
          .prepare(
            "CREATE TRIGGER synthetic_forget_failure BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
          )
          .run();
        page.on('request', (request) => {
          if (request.method() === 'DELETE') deletes++;
        });
        await page.route(
          '**/api/memories/*?expectedVersion=*',
          async (route) => {
            if (!fail)
              await (await app.mf.getD1Database('DB'))
                .prepare('DROP TRIGGER IF EXISTS synthetic_forget_failure')
                .run();
            await route.continue();
          },
        );
      },
    });
    try {
      const { page } = visit;
      await openForget(page);
      await confirmForget(page);
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Not forgotten' });
      await alert.waitFor();
      expect(await alert.textContent()).toContain(
        'Release process was not forgotten',
      );
      expect(await alert.textContent()).toContain('Nothing was deleted');
      expect(await row(page).count()).toBe(1);
      if (viewport.width > 1000)
        expect(await count(page).innerText()).toContain('3 memories');
      expect(deletes).toBe(1);
      fail = false;
      await alert.getByRole('button', { name: 'Try again' }).click();
      await page.getByText('Forgot Release process', { exact: true }).waitFor();
      expect(deletes).toBe(2);
    } finally {
      await visit.close();
    }
  });
  it('E20: a concurrent writer refreshes detail/history and requires another confirmation for version four', async () => {
    let deletes = 0;
    const visit = await forgetPage(browser, {
      viewport,
      configure: async (page) => {
        page.on('request', (request) => {
          if (request.method() === 'DELETE') deletes++;
        });
      },
    });
    try {
      const { page, app } = visit;
      await openForget(page);
      const original = (
        await memoryClient(app, '2026-07-28').call('get', { id: forgottenId })
      ).structuredContent;
      expect(
        (
          await memoryClient(app, '2026-07-28').call('update', {
            id: forgottenId,
            expectedVersion: 3,
            content: original?.content,
            tags: ['changed'],
          })
        ).isError,
      ).not.toBe(true);
      await confirmForget(page);
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Not forgotten: it changed' });
      await alert.getByRole('button', { name: 'Forget version 4…' }).waitFor();
      expect(deletes).toBe(1);
      if (viewport.width < 1000) await row(page).click();
      const history = page.getByRole('button', { name: /History.*4 versions/ });
      await history.waitFor();
      await history.click();
      await page.locator('[data-version-row="4"]').waitFor();
      await page
        .getByRole('dialog')
        .getByRole('button', { name: 'Close', exact: true })
        .click();
      await page.getByRole('button', { name: 'Forget version 4…' }).click();
      expect(await forgetDialog(page).textContent()).toContain(
        'You are forgetting version 4',
      );
      expect(deletes).toBe(1);
      await confirmForget(page);
      await page.getByText('Forgot Release process', { exact: true }).waitFor();
      expect(deletes).toBe(2);
    } finally {
      await visit.close();
    }
  });
  it('E21: forgetting the only memory leaves an empty list and reading pane with zero count', async () => {
    const visit = await forgetPage(browser, {
      viewport,
      seeds: [
        memoryFixture(1, {
          bucket: 'work/acme/api',
          content: '# Release process\nOnly memory.',
        }),
      ],
      start: `/memory?bucket=work/acme/api&scope=bucket&memory=${forgottenId}`,
    });
    try {
      const { page } = visit;
      await openForget(page);
      await confirmForget(page);
      await page.getByText('No memories left', { exact: true }).waitFor();
      if (viewport.width > 1000) {
        await page.getByText('Nothing to read', { exact: true }).waitFor();
        expect(
          await page.locator('[data-path="work/acme/api"]').innerText(),
        ).toContain('0 memories');
      }
      expect(await memoryRows(page).count()).toBe(0);
    } finally {
      await visit.close();
    }
  });
  it('E22: keyboard opens each trigger, Cancel owns initial focus, Tab is trapped and Escape returns focus', async () => {
    const visit = await forgetPage(browser, { viewport });
    try {
      const { page } = visit;
      const trigger = page.getByRole('button', {
        name: 'More actions',
        exact: true,
      });
      await trigger.focus();
      await page.keyboard.press('Enter');
      await page
        .getByRole('menuitem', { name: 'Forget memory…' })
        .press('Enter');
      const cancel = forgetDialog(page).getByRole('button', { name: 'Cancel' });
      await expect
        .poll(() => cancel.evaluate((el) => document.activeElement === el))
        .toBe(true);
      await page.keyboard.press('Shift+Tab');
      expect(
        await forgetDialog(page).evaluate((el) =>
          el.contains(document.activeElement),
        ),
      ).toBe(true);
      await page.keyboard.press('Tab');
      await page.keyboard.press('Escape');
      await expect
        .poll(() => trigger.evaluate((el) => document.activeElement === el))
        .toBe(true);
      if (viewport.width > 1000) {
        const actions = page.locator('[data-memory-actions]');
        expect(await actions.count()).toBe(await memoryRows(page).count());
        expect(
          await actions.evaluateAll((elements) =>
            elements.every((el) => (el as HTMLButtonElement).tabIndex === 0),
          ),
        ).toBe(true);
        await actions.nth(1).focus();
        await page.keyboard.press('Enter');
        await page
          .getByRole('menuitem', { name: 'Forget memory…' })
          .press('Enter');
        await cancel.waitFor();
      }
    } finally {
      await visit.close();
    }
  });
});
it.each(['list', 'search'] as const)(
  'E19: %s row forgetting keeps scroll and focus at its neighbor without changing an unrelated pane',
  async (source) => {
    const seeds =
      source === 'list'
        ? [...typicalMemories, ...manyMemories]
        : typicalMemories;
    const visit = await forgetPage(browser, {
      seeds,
      start: `/memory?bucket=work/acme&memory=${forgottenId}${source === 'search' ? '&q=deploy' : ''}`,
    });
    try {
      const { page } = visit;
      await detail(page)
        .getByRole('heading', { name: 'Release process', exact: true })
        .waitFor();
      const target = source === 'list' ? memoryId(110) : memoryId(2);
      const rows = page.locator(
        source === 'list' ? '[data-memory-row]' : '[data-search-result]',
      );
      await row(page, target).waitFor();
      const ids = await rows.evaluateAll((elements) =>
        elements.map(
          (el) =>
            el.getAttribute('data-memory-row') ??
            el.getAttribute('data-search-result'),
        ),
      );
      const index = ids.indexOf(target);
      const next = ids[index + 1] ?? ids[index - 1];
      await page
        .locator(`[data-memory-actions="${target}"]`)
        .scrollIntoViewIfNeeded();
      const top = await page
        .locator('[data-memory-list]')
        .evaluate((el) => el.scrollTop);
      await openForget(page, target);
      await confirmForget(page);
      await expect.poll(() => row(page, target).count()).toBe(0);
      await expect
        .poll(() =>
          row(page, next ?? '').evaluate((el) => document.activeElement === el),
        )
        .toBe(true);
      expect(
        await page.locator('[data-memory-list]').evaluate((el) => el.scrollTop),
      ).toBe(top);
      expect(new URL(page.url()).searchParams.get('memory')).toBe(forgottenId);
      expect(await detail(page).textContent()).toContain('Release process');
    } finally {
      await visit.close();
    }
  },
);
it('E19: a search confirmation waits for detail to obtain the displayed version', async () => {
  const gate = deferred();
  const visit = await forgetPage(browser, {
    start: `/memory?bucket=work/acme&q=deploy&memory=${forgottenId}`,
    configure: async (page) => {
      await page.route(`**/api/memories/${memoryId(2)}`, async (route) => {
        const response = await route.fetch();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    await openForget(page, memoryId(2));
    expect(
      await forgetDialog(page)
        .getByRole('button', { name: 'Forget memory', exact: true })
        .isDisabled(),
    ).toBe(true);
    gate.resolve();
    await expect
      .poll(() =>
        forgetDialog(page)
          .getByRole('button', { name: 'Forget memory', exact: true })
          .isEnabled(),
      )
      .toBe(true);
    expect(await forgetDialog(page).textContent()).toContain(
      'You are forgetting version 1',
    );
  } finally {
    gate.resolve();
    await visit.close();
  }
});
