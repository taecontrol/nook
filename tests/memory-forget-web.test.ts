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
  uniqueTerm,
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
  it('E20: Check again resolves a 503 before retry; repeated Try again submits only one new request', async () => {
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
      const unconfirmed = page
        .getByRole('alert')
        .filter({ hasText: 'Forget not confirmed' });
      await unconfirmed.waitFor();
      expect(await unconfirmed.textContent()).not.toContain(
        'Nothing was deleted',
      );
      await unconfirmed.getByRole('button', { name: 'Check again' }).click();
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
      // Activate twice before React replaces the failed entry with progress.
      await alert
        .getByRole('button', { name: 'Try again' })
        .evaluate((button: HTMLButtonElement) => {
          button.click();
          button.click();
        });
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
it.each([
  { source: 'list', height: 900 },
  { source: 'search', height: 900 },
  { source: 'list', height: 300 },
] as const)(
  'E19: $source row forgetting at $height px keeps scroll and focus at its neighbor without changing an unrelated pane',
  async ({ source, height }) => {
    const seeds =
      source === 'list'
        ? [...typicalMemories, ...manyMemories]
        : typicalMemories;
    const visit = await forgetPage(browser, {
      seeds,
      viewport: { width: 1440, height },
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
    await expect
      .poll(() =>
        forgetDialog(page)
          .getByRole('button', { name: 'Cancel', exact: true })
          .evaluate((el) => document.activeElement === el),
      )
      .toBe(true);
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
it('E20: exact cached detail and history return before held recovery reads', async () => {
  const recovery = deferred();
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page.locator('[data-version-row="1"]').waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.fulfill({ status: 403, body: 'Access denied' }),
    );
    await page.route(`**/api/memories/${forgottenId}{,/*}`, async (route) => {
      if (route.request().method() !== 'GET') {
        await route.continue();
        return;
      }
      const response = await route.fetch();
      await recovery.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await openForget(page);
    await confirmForget(page);
    await page
      .getByRole('alert')
      .filter({ hasText: 'Not forgotten' })
      .waitFor();
    await detail(page)
      .getByRole('heading', { name: 'Release process', exact: true })
      .waitFor();
    expect(await detail(page).textContent()).toContain(uniqueTerm);
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page.locator('[data-version-row="1"]').waitFor();
    expect(await page.locator('[data-version-row]').count()).toBe(3);
  } finally {
    recovery.resolve();
    await visit.close();
  }
});
it('E18/E24: a first search started while forgetting resumes after settlement', async () => {
  const gate = deferred();
  const arrived = deferred();
  const visit = await forgetPage(browser);
  let searchReads = 0;
  try {
    const { page } = visit;
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await openForget(page);
    await confirmForget(page);
    await arrived.promise;
    page.on('request', (request) => {
      if (new URL(request.url()).pathname === '/api/memories/search')
        searchReads++;
    });
    const search = page.getByRole('textbox', { name: /Search memories/ });
    await search.fill(uniqueTerm);
    await search.press('Enter');
    const loading = page.getByRole('status', {
      name: 'Searching memories',
      exact: true,
    });
    await loading.waitFor();
    expect(searchReads).toBe(0);
    expect(await row(page).count()).toBe(0);
    gate.resolve();
    await loading.waitFor({ state: 'hidden' });
    await page.getByText('No memories found', { exact: true }).waitFor();
    expect(searchReads).toBe(1);
    expect(await row(page).count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E18/E24: a pending Back to forgotten detail reads authoritative absence after settlement', async () => {
  const gate = deferred();
  const arrived = deferred();
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await page.getByRole('button', { name: /History.*3 versions/ }).click();
    await page.locator('[data-version-row="1"]').click();
    await page
      .getByRole('dialog')
      .getByText('Version 1', { exact: true })
      .waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await openForget(page);
    await confirmForget(page);
    await arrived.promise;
    await page.goBack();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('memory'))
      .toBe(forgottenId);
    const loading = page.getByRole('status', {
      name: 'Loading memory',
      exact: true,
    });
    await loading.waitFor();
    expect(await detail(page).count()).toBe(0);
    const absent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}` &&
        response.status() === 404,
    );
    gate.resolve();
    await absent;
    await loading.waitFor({ state: 'hidden' });
    expect(await detail(page).count()).toBe(0);
    expect(await page.locator('[data-history-sheet]').count()).toBe(0);
    expect(await page.locator('[data-version-row]').count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E18/E24: a first load in another inheriting bucket resumes only after forgetting settles', async () => {
  const gate = deferred();
  const arrived = deferred();
  const visit = await forgetPage(browser);
  let childReads = 0;
  try {
    const { page } = visit;
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      arrived.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await openForget(page);
    await confirmForget(page);
    await arrived.promise;
    page.on('request', (request) => {
      const url = new URL(request.url());
      if (
        url.pathname === '/api/memories' &&
        url.searchParams.get('bucket') === 'work/acme/api'
      )
        childReads++;
    });
    await page.locator('[data-path="work/acme/api"]').getByRole('link').click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('bucket'))
      .toBe('work/acme/api');
    const loading = page.getByRole('status', {
      name: 'Loading memories',
      exact: true,
    });
    await loading.waitFor();
    expect(childReads).toBe(0);
    expect(await row(page).count()).toBe(0);
    gate.resolve();
    await loading.waitFor({ state: 'hidden' });
    await memoryRows(page).first().waitFor();
    expect(childReads).toBe(1);
    expect(await row(page).count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E18/E20: one failed forget cannot restore a neighbor history that already returned not found', async () => {
  const gate = deferred();
  const arrived = deferred();
  const recovery = deferred();
  const neighbor = memoryId(2);
  let recovering = false;
  const visit = await forgetPage(browser, {
    start: `/memory?bucket=work/acme&memory=${neighbor}`,
    configure: async (page) => {
      await page.route(
        `**/api/memories/${forgottenId}?expectedVersion=*`,
        async (route) => {
          arrived.resolve();
          await gate.promise;
          await route
            .fulfill({ status: 403, body: 'Access denied' })
            .catch(() => {});
        },
      );
      await page.route(`**/api/memories/${neighbor}{,/*}`, async (route) => {
        if (!recovering) {
          await route.continue();
          return;
        }
        const response = await route.fetch();
        await recovery.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    const { page, app } = visit;
    const history = page.locator('[data-history-sheet]');
    const bodyTitle = history.getByText('Acme API deployment', { exact: true });
    await page.getByRole('button', { name: /History.*1 version/ }).click();
    await page.locator('[data-version-row="1"]').click();
    await bodyTitle.waitFor();
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    // Keep the previously rendered detail until the independent history read
    // reports absence; the pending forget will cancel this stale detail read.
    await page.route(`**/api/memories/${neighbor}`, async (route) => {
      const response = await route.fetch();
      await recovery.promise;
      await route.fulfill({ response }).catch(() => {});
    });
    await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'));
    expect(
      (
        await memoryClient(app, '2026-07-28').call('forget', {
          id: neighbor,
          expectedVersion: 1,
        })
      ).isError,
    ).not.toBe(true);
    const absent = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname ===
          `/api/memories/${neighbor}/versions` && response.status() === 404,
    );
    await page.goBack();
    await absent;
    await history
      .getByText('Could not load history', { exact: true })
      .waitFor();
    expect(await bodyTitle.count()).toBe(0);
    await page
      .getByRole('dialog')
      .getByRole('button', { name: 'Close', exact: true })
      .click();
    await openForget(page, forgottenId);
    await confirmForget(page);
    await arrived.promise;
    await page.goBack();
    await history
      .getByText('Could not load history', { exact: true })
      .waitFor();
    recovering = true;
    gate.resolve();
    await expect.poll(() => row(page).count()).toBe(1);
    await page
      .getByRole('alert', { includeHidden: true })
      .filter({ hasText: 'Not forgotten' })
      .waitFor();
    expect(await bodyTitle.count()).toBe(0);
    await history
      .getByText('Could not load history', { exact: true })
      .waitFor();
  } finally {
    gate.resolve();
    recovery.resolve();
    await visit.close();
  }
});
it('E18/E20: a committed DELETE with a lost response is confirmed by not-found without restoring forgotten content', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      const response = await route.fetch();
      expect(response.status()).toBe(204);
      await route.abort();
    });
    await confirmForget(page);
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    expect(await row(page).count()).toBe(0);
    expect(await detail(page).textContent()).not.toContain('Release process');
    await page.reload();
    await memoryRows(page).first().waitFor();
    expect(await row(page).count()).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E18: an authoritative not-found refresh cannot render previously cached detail or History', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page, app } = visit;
    await detail(page)
      .getByRole('heading', { name: 'Release process', exact: true })
      .waitFor();
    expect(
      (
        await memoryClient(app, '2026-07-28').call('forget', {
          id: forgottenId,
          expectedVersion: 3,
        })
      ).isError,
    ).not.toBe(true);
    await page.clock.setFixedTime(new Date('2030-01-01T00:00:00Z'));
    const missing = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}` &&
        response.status() === 404,
    );
    await row(page).hover();
    await missing;
    await expect.poll(() => detail(page).count()).toBe(0);
    expect(
      await page.getByRole('button', { name: /History.*versions?/ }).count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E20: failed conflict refresh offers a read retry, never the old version or an automatic DELETE', async () => {
  const visit = await forgetPage(browser);
  let unavailable = true;
  let deletes = 0;
  try {
    const { page, app } = visit;
    page.on('request', (request) => {
      if (request.method() === 'DELETE') deletes++;
    });
    await openForget(page);
    const client = memoryClient(app, '2026-07-28');
    const current = (await client.call('get', { id: forgottenId }))
      .structuredContent;
    expect(
      (
        await client.call('update', {
          id: forgottenId,
          expectedVersion: 3,
          content: current?.content,
          tags: ['changed'],
        })
      ).isError,
    ).not.toBe(true);
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      if (unavailable)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"_tag":"ServiceUnavailable"}',
        });
      else await route.continue();
    });
    await confirmForget(page);
    await page
      .getByRole('button', { name: 'Refresh memory', exact: true })
      .waitFor();
    expect(
      await page.getByRole('button', { name: 'Forget version 3…' }).count(),
    ).toBe(0);
    expect(deletes).toBe(1);
    unavailable = false;
    await page
      .getByRole('button', { name: 'Refresh memory', exact: true })
      .click();
    await page.getByRole('button', { name: 'Forget version 4…' }).waitFor();
    expect(deletes).toBe(1);
  } finally {
    await visit.close();
  }
});
it('E20: an unreadable lost-response outcome stays hidden and checks again without repeating DELETE', async () => {
  const visit = await forgetPage(browser);
  let unavailable = true;
  let deletes = 0;
  try {
    const { page } = visit;
    await openForget(page);
    page.on('request', (request) => {
      if (request.method() === 'DELETE') deletes++;
    });
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      await route.fetch();
      await route.abort();
    });
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      if (unavailable)
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: '{"_tag":"ServiceUnavailable"}',
        });
      else await route.continue();
    });
    await confirmForget(page);
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await alert.waitFor();
    expect(await row(page).count()).toBe(0);
    expect(await alert.textContent()).not.toContain('Nothing was deleted');
    expect(await detail(page).textContent()).not.toContain('Release process');
    unavailable = false;
    await alert
      .getByRole('button', { name: 'Check again', exact: true })
      .click();
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    expect(deletes).toBe(1);
  } finally {
    await visit.close();
  }
});
it.each([3, 4])(
  'E20: Check again reads a still-live version %s without automatically submitting another DELETE',
  async (version) => {
    const visit = await forgetPage(browser);
    let unavailable = true;
    let loseDelivery = true;
    let deletes = 0;
    try {
      const { page, app } = visit;
      await openForget(page);
      page.on('request', (request) => {
        if (request.method() === 'DELETE') deletes++;
      });
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        if (loseDelivery) await route.abort();
        else await route.continue();
      });
      await page.route(`**/api/memories/${forgottenId}`, async (route) => {
        if (unavailable)
          await route.fulfill({
            status: 503,
            contentType: 'application/json',
            body: '{"_tag":"ServiceUnavailable"}',
          });
        else await route.continue();
      });
      await confirmForget(page);
      const unknown = page
        .getByRole('alert')
        .filter({ hasText: 'Forget not confirmed' });
      await unknown.waitFor();
      expect(await unknown.textContent()).not.toContain('Nothing was deleted');
      if (version === 4) {
        const client = memoryClient(app, '2026-07-28');
        const current = (await client.call('get', { id: forgottenId }))
          .structuredContent;
        expect(
          (
            await client.call('update', {
              id: forgottenId,
              expectedVersion: 3,
              content: current?.content,
              tags: ['changed'],
            })
          ).isError,
        ).not.toBe(true);
      }
      unavailable = false;
      await unknown
        .getByRole('button', { name: 'Check again', exact: true })
        .click();
      await row(page).waitFor();
      expect(deletes).toBe(1);
      loseDelivery = false;
      if (version === 3)
        await page
          .getByRole('button', { name: 'Try again', exact: true })
          .click();
      else {
        await page.getByRole('button', { name: 'Forget version 4…' }).click();
        expect(await forgetDialog(page).textContent()).toContain(
          'You are forgetting version 4',
        );
        expect(deletes).toBe(1);
        await confirmForget(page);
      }
      await page.getByText('Forgot Release process', { exact: true }).waitFor();
      expect(deletes).toBe(2);
      expect(await row(page).count()).toBe(0);
    } finally {
      await visit.close();
    }
  },
);
it('E19/E24: a pending inherited memory does not enter the bucket-only view', async () => {
  const gate = deferred();
  const visit = await forgetPage(browser, {
    configure: async (page) => {
      await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    await page
      .getByRole('button', { name: 'Only this bucket', exact: true })
      .click();
    await expect.poll(() => memoryRows(page).count()).toBe(3);
    await page
      .getByRole('button', { name: 'Include inherited', exact: true })
      .click();
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    await openForget(page, memoryId(6));
    await confirmForget(page);
    await page.getByText('Forgetting Prefer pnpm…', { exact: true }).waitFor();
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
      await page.getByText('Forgetting Prefer pnpm…', { exact: true }).count(),
    ).toBe(0);
    expect(await memoryRows(page).count()).toBe(3);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
