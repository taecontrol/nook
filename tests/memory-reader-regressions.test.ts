import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryClient,
  memoryCounts,
  memoryFixture,
  memoryId,
  memoryPage,
  memoryRows,
  memoryRuntime,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it.each([
  [
    'long',
    `# ${'Deployment review '.repeat(10)}Complete heading tail\n\nBody remains visible.`,
  ],
  [
    'multiline Setext',
    'Preserve this line\nComplete heading tail\n===\n\nBody remains visible.',
  ],
])(
  'E23/E24: a %s heading remains complete when its display title is an excerpt',
  async (_, content) => {
    const visit = await memoryPage(browser, {
      seeds: [],
      configure: async (_, app) => {
        const client = memoryClient(app, '2026-07-28');
        const write = await client.call('remember', {
          bucket: 'work/acme',
          content,
        });
        expect(write.isError).not.toBe(true);
        expect(
          (await client.call('get', { id: write.structuredContent?.id }))
            .structuredContent?.content,
        ).toBe(content);
      },
    });
    try {
      const detail = visit.page.getByRole('article', { name: 'Memory detail' });
      await detail
        .getByText('Body remains visible.', { exact: true })
        .waitFor();
      expect(
        await detail.locator('[data-memory-markdown]').innerText(),
      ).toContain('Complete heading tail');
    } finally {
      await visit.close();
    }
  },
);

it('E24: an initial heading keeps inline links, code and emphasis', async () => {
  const visit = await memoryPage(browser, {
    seeds: [],
    configure: async (_, app) => {
      expect(
        (
          await memoryClient(app, '2026-07-28').call('remember', {
            bucket: 'work/acme',
            content:
              '# Use **pnpm** and `nook` with the [release workflow](https://github.com/taecontrol/nook/releases)\n\nBody remains visible.',
          })
        ).isError,
      ).not.toBe(true);
    },
  });
  try {
    const detail = visit.page.getByRole('article', { name: 'Memory detail' });
    await detail.getByText('Body remains visible.', { exact: true }).waitFor();
    const markdown = detail.locator('[data-memory-markdown]');
    expect(
      await markdown
        .getByRole('link', { name: 'release workflow', exact: true })
        .getAttribute('href'),
    ).toBe('https://github.com/taecontrol/nook/releases');
    expect(await markdown.locator('code').innerText()).toBe('nook');
    expect(await markdown.locator('strong').innerText()).toBe('pnpm');
  } finally {
    await visit.close();
  }
});

it('E22/E28: Retry recovers failed counts and the feed with an existing URL selection', async () => {
  const visit = await memoryPage(browser, {
    seeds: manyMemories,
    start: `/memory?bucket=work/acme&memory=${memoryId(100)}`,
    configure: async (_, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE memories RENAME TO unavailable_memories')
        .run();
    },
  });
  try {
    const { page } = visit;
    await page.getByText('Could not load memories', { exact: true }).waitFor();
    await page
      .getByText('Could not load memory counts', { exact: true })
      .waitFor();
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE unavailable_memories RENAME TO memories')
      .run();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => memoryRows(page).count()).toBe(25);
    await page
      .getByText('90 memories · newest first', { exact: true })
      .waitFor();
    await expect
      .poll(() =>
        page
          .getByRole('navigation', { name: 'Memory buckets' })
          .locator('[data-path="work/acme"]')
          .innerText(),
      )
      .toContain('60 memories');
    await page.getByRole('article', { name: 'Memory detail' }).waitFor();
  } finally {
    await visit.close();
  }
});

it('E22/E28: a counts-only failure labels loaded rows and permits an independent retry', async () => {
  const countFailed = deferred();
  const visit = await memoryPage(browser, {
    seeds: manyMemories,
    start: `/memory?bucket=work/acme&memory=${memoryId(100)}`,
    configure: async (page, app) => {
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare('ALTER TABLE memories RENAME TO unavailable_memories')
        .run();
      page.on('response', (response) => {
        if (new URL(response.url()).pathname === '/api/memories/counts')
          countFailed.resolve();
      });
      await page.route('**/api/memories?**', async (route) => {
        await countFailed.promise;
        await db
          .prepare('ALTER TABLE unavailable_memories RENAME TO memories')
          .run();
        await route.continue();
      });
    },
  });
  try {
    const { page } = visit;
    await page
      .getByText('Could not load memory counts', { exact: true })
      .waitFor();
    await expect.poll(() => memoryRows(page).count()).toBe(25);
    expect(await page.locator('[data-memory-list]').innerText()).toContain(
      '25 memories loaded · newest first',
    );
    await page
      .getByRole('button', { name: 'Retry counts', exact: true })
      .click();
    await page
      .getByText('90 memories · newest first', { exact: true })
      .waitFor();
    expect(
      await page
        .getByText('Could not load memory counts', { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});

it('E23/E27: a phone can return from an out-of-lineage URL to its bucket and scope', async () => {
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
    seeds: [
      ...typicalMemories,
      memoryFixture(8, {
        bucket: 'personal',
        content: '# Private sibling\nA synthetic sibling note.',
      }),
    ],
    start: `/memory?bucket=work/acme&scope=bucket&memory=${memoryId(8)}`,
  });
  try {
    const { page } = visit;
    await page.getByText('Choose a memory', { exact: true }).waitFor();
    expect(await page.locator('[data-memory-list]').isVisible()).toBe(false);
    expect(await page.locator('main').innerText()).not.toContain(
      'Private sibling',
    );
    await page.getByRole('link', { name: 'Memories', exact: true }).click();
    await expect.poll(() => memoryRows(page).count()).toBe(3);
    expect(await page.locator('[data-memory-list]').isVisible()).toBe(true);
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
    expect(new URL(page.url()).searchParams.get('scope')).toBe('bucket');
    expect(new URL(page.url()).searchParams.has('memory')).toBe(false);
  } finally {
    await visit.close();
  }
});

it('E23/E25: a phone displays the complete maximum-length bucket attribution within the detail', async () => {
  const bucket = ['a', 'b', 'c', 'd', 'e', 'f']
    .map((value) => value.repeat(32))
    .join('/');
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
    seeds: [],
    start: `/memory?bucket=${bucket}`,
    configure: async (_, app) => {
      const client = memoryClient(app, '2026-07-28');
      expect(
        (await client.call('create_bucket', { path: bucket })).isError,
      ).not.toBe(true);
      expect(
        (
          await client.call('remember', {
            bucket,
            content: '# Path metadata\n\nRead the complete bucket attribution.',
          })
        ).isError,
      ).not.toBe(true);
    },
  });
  try {
    const { page } = visit;
    await memoryRows(page).first().click();
    const detail = page.getByRole('article', { name: 'Memory detail' });
    await detail
      .getByText('Read the complete bucket attribution.', { exact: true })
      .waitFor();
    const badge = detail.locator('[data-slot="badge"]').first();
    expect(await badge.innerText()).toBe(bucket);
    const bounds = await badge.evaluate((node) => ({
      width: node.getBoundingClientRect().width,
      available: node.parentElement?.getBoundingClientRect().width ?? 0,
      textWidth: node.scrollWidth,
      clientWidth: node.clientWidth,
    }));
    expect(bounds.width).toBeLessThanOrEqual(bounds.available);
    expect(bounds.textWidth).toBe(bounds.clientWidth);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await visit.close();
  }
});

it('E15: Buckets reports the memory deletion blocker without claiming child buckets', async () => {
  const visit = await memoryPage(browser, {
    seeds: [],
    start: '/buckets',
    configure: async (_, app) => {
      const client = memoryClient(app, '2026-07-28');
      expect(
        (await client.call('create_bucket', { path: 'work/kept-memory' }))
          .isError,
      ).not.toBe(true);
      expect(
        (
          await client.call('remember', {
            bucket: 'work/kept-memory',
            content: '# Keep this memory',
          })
        ).isError,
      ).not.toBe(true);
    },
  });
  try {
    const { page } = visit;
    await page
      .getByRole('button', { name: 'Actions for work/kept-memory' })
      .click();
    await page.getByRole('menuitem', { name: /Delete/ }).click();
    const deleted = page.waitForResponse(
      (r) => r.request().method() === 'DELETE',
    );
    await page
      .getByRole('button', { name: 'Delete bucket', exact: true })
      .click();
    expect((await deleted).status()).toBe(409);
    await page.getByRole('alert').waitFor();
    expect(await page.getByRole('alert').innerText()).toContain(
      'Delete its memories first.',
    );
    expect(await page.getByRole('alert').innerText()).not.toContain(
      'child buckets',
    );
    expect(await memoryCounts(visit.app)).toEqual({ memories: 1, versions: 1 });
  } finally {
    await visit.close();
  }
});

it('E30: Memory preserves a pending optimistic bucket through real tab refocus', async () => {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  const gate = deferred();
  let gets = 0;
  let posted = false;
  try {
    await seedMemories(app);
    page.on('request', (r) => {
      if (new URL(r.url()).pathname === '/api/buckets' && r.method() === 'GET')
        gets++;
    });
    await page.route('**/api/buckets', async (route) => {
      if (route.request().method() === 'POST') {
        posted = true;
        await gate.promise;
      }
      await route.continue();
    });
    await page.goto(`${app.origin}/buckets`);
    const field = page.getByRole('textbox', {
      name: 'New bucket path',
      exact: true,
    });
    await field.fill('work/pending-memory');
    await field.press('Enter');
    await expect.poll(() => posted).toBe(true);
    const initial = gets;
    await page.getByRole('link', { name: 'Memory', exact: true }).click();
    const row = page
      .getByRole('navigation', { name: 'Memory buckets' })
      .locator('[data-path="work/pending-memory"]');
    await row.waitFor();
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    await page.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('visible');
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    expect(gets).toBe(initial);
    expect(await row.isVisible()).toBe(true);
    const finished = page.waitForResponse(
      (r) =>
        new URL(r.url()).pathname === '/api/buckets' &&
        r.request().method() === 'POST',
    );
    gate.resolve();
    expect((await finished).status()).toBe(200);
    await expect.poll(() => gets).toBeGreaterThan(initial);
    await row.waitFor();
  } finally {
    gate.resolve();
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});
