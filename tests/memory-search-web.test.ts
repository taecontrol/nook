import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  manyMemories,
  memoryId,
  typicalMemories,
} from './fixtures/memories.ts';
import { searchMemories } from './fixtures/search-corpus.ts';
import { deferred } from './support/machines.ts';
import { memoryRows } from './support/memory.ts';
import { httpSearch, searchPage } from './support/search.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
const field = (page: Page) =>
  page.getByRole('textbox', { name: /Search memories visible/ });
const rows = (page: Page) => page.locator('[data-search-result]');
it('E17: debounce and Enter put q in the URL; reload, selection, Back, scope and bucket retain it; Esc clears', async () => {
  const visit = await searchPage(browser, {
    seeds: searchMemories,
    start: `/memory?bucket=work/acme&memory=${memoryId(21)}`,
  });
  try {
    const { page } = visit;
    await memoryRows(page).first().waitFor();
    const openBefore = new URL(page.url()).searchParams.get('memory');
    await page.keyboard.press('/');
    expect(
      await field(page).evaluate((node) => document.activeElement === node),
    ).toBe(true);
    await field(page).fill('how do we deploy');
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('how do we deploy');
    await rows(page).first().waitFor();
    expect(new URL(page.url()).searchParams.get('memory')).toBe(openBefore);
    await page.reload();
    await rows(page).first().waitFor();
    expect(await field(page).inputValue()).toBe('how do we deploy');
    await field(page).press('ArrowDown');
    expect(
      await rows(page)
        .first()
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('ArrowDown');
    expect(
      await rows(page)
        .nth(1)
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('ArrowUp');
    expect(
      await rows(page)
        .first()
        .evaluate((node) => node === document.activeElement),
    ).toBe(true);
    await page.locator(`[data-search-result="${memoryId(20)}"]`).focus();
    await page.keyboard.press('Enter');
    await page
      .getByRole('heading', { name: 'Proceso de release', exact: true })
      .waitFor();
    expect(new URL(page.url()).searchParams.get('q')).toBe('how do we deploy');
    await page.goBack();
    await rows(page).first().waitFor();
    expect(new URL(page.url()).searchParams.get('q')).toBe('how do we deploy');
    expect(new URL(page.url()).searchParams.get('memory')).toBe(openBefore);
    await page
      .getByRole('button', { name: 'Only this bucket', exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('scope'))
      .toBe('bucket');
    expect(new URL(page.url()).searchParams.get('q')).toBe('how do we deploy');
    await page.locator('[data-memory-buckets] [data-path="work"] a').click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('bucket'))
      .toBe('work');
    expect(await field(page).inputValue()).toBe('how do we deploy');
    await field(page).fill('pnpm verify');
    await field(page).press('Enter');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('pnpm verify');
    await field(page).press('Escape');
    await memoryRows(page).first().waitFor();
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    expect(await field(page).inputValue()).toBe('');
  } finally {
    await visit.close();
  }
});
it('E18: owner HTTP highlights real keyword ranges, labels meaning and inherited buckets, returns provenance and at most twenty', async () => {
  const visit = await searchPage(browser, {
    seeds: [...searchMemories, ...typicalMemories],
    start: '/memory?bucket=work/acme&q=how%20do%20we%20deploy',
  });
  try {
    const { page, app } = visit;
    const release = page.locator(`[data-search-result="${memoryId(20)}"]`);
    await release.waitFor();
    expect(await release.innerText()).toContain('By meaning');
    expect(await release.innerText()).toContain('work');
    expect(await release.locator('span[title="work"]').innerText()).toBe(
      'work',
    );
    expect(await release.locator('mark').count()).toBe(0);
    const response = await httpSearch(app, 'pnpm verify');
    const first = response.results[0];
    expect(
      first.highlights?.map(([s, e]) =>
        first.snippet.slice(s, e).toLowerCase(),
      ),
    ).toEqual(expect.arrayContaining(['pnpm', 'verify']));
    expect(first.provenance).toBeDefined();
    expect(first.createdAt).toBeDefined();
    expect('content' in first).toBe(false);
    await field(page).fill('pnpm verify');
    await field(page).press('Enter');
    await expect
      .poll(() => rows(page).first().locator('mark').count())
      .toBeGreaterThanOrEqual(2);
    expect(await rows(page).first().innerText()).not.toContain('luis-mbp');
    const meaning = (await httpSearch(app, 'how do we deploy')).results.find(
      (r) => r.id === memoryId(20),
    );
    expect(meaning?.snippet).toMatch(/^#? ?Proceso de release/);
    expect(meaning?.highlights).toEqual([]);
  } finally {
    await visit.close();
  }
  const volume = await searchPage(browser, {
    seeds: manyMemories,
    start: '/memory?bucket=work/acme&q=deployment',
  });
  try {
    await expect.poll(() => rows(volume.page).count()).toBe(20);
  } finally {
    await volume.close();
  }
});
async function columnBoxes(page: Page) {
  return page
    .locator(
      '[data-memory-layout], [data-memory-bucket-column], [data-memory-list], [data-memory-reading], [data-memory-list] > .sticky',
    )
    .evaluateAll((nodes) =>
      nodes.map((node) => {
        const { x, y, width, height } = node.getBoundingClientRect();
        // Phone results flow vertically; column positions and the fixed header stay put.
        return [
          x,
          y,
          width,
          matchMedia('(min-width: 1024px)').matches ||
          node.classList.contains('sticky')
            ? height
            : null,
        ];
      }),
    );
}
it.each([
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
])(
  'E19: previous results dim during loading, real D1 error retries, and column positions stay fixed at $width×$height',
  async (viewport) => {
    const visit = await searchPage(browser, {
      seeds: searchMemories,
      viewport,
    });
    const gate = deferred();
    try {
      const { page, app } = visit;
      await memoryRows(page).first().waitFor();
      const idle = await columnBoxes(page);
      await field(page).fill('how do we deploy');
      await field(page).press('Enter');
      await rows(page).first().waitFor();
      expect(await columnBoxes(page)).toEqual(idle);
      const previous = await rows(page).allTextContents();
      await page.route('**/api/memories/search?*', async (route) => {
        const response = await route.fetch();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
      await field(page).fill('pnpm verify');
      await field(page).press('Enter');
      await page.getByText('Searching…', { exact: true }).waitFor();
      expect(await rows(page).allTextContents()).toEqual(previous);
      expect(
        await page
          .locator('[data-search-results]')
          .evaluate((node) => getComputedStyle(node).opacity),
      ).toBe('0.5');
      expect(
        await page
          .locator('search')
          .getByRole('status', { name: 'Loading', exact: true })
          .count(),
      ).toBe(1);
      expect(await columnBoxes(page)).toEqual(idle);
      gate.resolve();
      await page.unroute('**/api/memories/search?*');
      await expect
        .poll(() => rows(page).first().innerText())
        .toContain('Required verification');
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
        .run();
      await field(page).fill('deployment');
      await field(page).press('Enter');
      await page
        .getByText('Could not search memories', { exact: true })
        .waitFor();
      expect(await columnBoxes(page)).toEqual(idle);
      await db
        .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
        .run();
      await page
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await rows(page).first().waitFor();
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
it('E19: meaning failures explain incomplete results, no matches clear, and a fresh owner has a disabled search', async () => {
  const visit = await searchPage(browser, {
    seeds: searchMemories,
    configure: async (app) => {
      app.services.failEmbedding = true;
    },
  });
  try {
    const { page } = visit;
    await field(page).fill('pnpm verify');
    await field(page).press('Enter');
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').innerText()).toMatch(
      /exact words only|meaning.*unavailable/i,
    );
    expect(await page.getByRole('alert').innerText()).toMatch(
      /missing|incomplete/i,
    );
    await field(page).fill('kubernetes helm chart');
    await field(page).press('Enter');
    await page.getByText('No memories found', { exact: true }).waitFor();
    await page
      .getByRole('button', { name: 'Clear search', exact: true })
      .last()
      .click();
    await memoryRows(page).first().waitFor();
  } finally {
    await visit.close();
  }
  const fresh = await searchPage(browser, {
    seeds: [],
    start: '/memory?bucket=me',
  });
  try {
    await fresh.page
      .getByText('Agents have not stored any memories yet.', { exact: true })
      .waitFor();
    expect(await field(fresh.page).isDisabled()).toBe(true);
  } finally {
    await fresh.close();
  }
});
it('E20: an idle page has the search affordance and makes zero search requests', async () => {
  let requests = 0;
  const visit = await searchPage(browser, {
    seeds: searchMemories,
    configure: async (_app, page) => {
      page.on('request', (request) => {
        if (new URL(request.url()).pathname === '/api/memories/search')
          requests++;
      });
    },
  });
  try {
    await field(visit.page).waitFor();
    await memoryRows(visit.page).first().waitFor();
    expect(requests).toBe(0);
    expect(visit.app.services.embeddingCalls).toEqual([]);
    expect(visit.app.services.queries).toEqual([]);
  } finally {
    await visit.close();
  }
});
it('E17: the debounce commits at 250 ms and Enter commits before the timer fires', async () => {
  const visit = await searchPage(browser, { seeds: searchMemories });
  try {
    const { page } = visit;
    await memoryRows(page).first().waitFor();
    const time = new Date('2026-10-10T20:00:00Z');
    await page.clock.install({ time });
    await page.clock.pauseAt(new Date(time.getTime() + 1000));
    await field(page).fill('how do we deploy');
    await page.clock.runFor(249);
    expect(new URL(page.url()).searchParams.has('q')).toBe(false);
    await page.clock.runFor(1);
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('how do we deploy');
    await field(page).fill('pnpm verify');
    await field(page).press('Enter');
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('pnpm verify');
    await page.clock.resume();
  } finally {
    await visit.close();
  }
});
it('E17 phone: a result opens the reading pane and Results returns with q intact', async () => {
  const visit = await searchPage(browser, {
    seeds: searchMemories,
    viewport: { width: 390, height: 844 },
    start: '/memory?bucket=work/acme&q=how%20do%20we%20deploy',
  });
  try {
    await visit.page.locator(`[data-search-result="${memoryId(20)}"]`).click();
    await visit.page
      .getByRole('heading', { name: 'Proceso de release', exact: true })
      .waitFor();
    await visit.page
      .getByRole('link', { name: 'Results', exact: true })
      .click();
    await rows(visit.page).first().waitFor();
    expect(await field(visit.page).inputValue()).toBe('how do we deploy');
  } finally {
    await visit.close();
  }
});
