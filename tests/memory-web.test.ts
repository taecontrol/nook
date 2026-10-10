import { randomUUID } from 'node:crypto';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  manyMemories,
  memoryFixture,
  memoryId,
  memoryPage,
  memoryRows,
  releaseContent,
  tenTags,
  typicalMemories,
} from './support/memory.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it('E22: desktop expands the selected bucket, labels the ordered lineage and reloads the selected memory', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    await page.getByRole('heading', { name: 'Memory', exact: true }).waitFor();
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    const tree = page.getByRole('navigation', { name: 'Memory buckets' });
    expect(
      await tree
        .locator('[data-path="work/acme"] a')
        .getAttribute('aria-current'),
    ).toBe('page');
    expect(await tree.locator('[data-path="work/acme"]').innerText()).toContain(
      '3 memories',
    );
    expect(await tree.locator('[data-path="work"]').innerText()).toContain(
      '2 memories',
    );
    expect(
      await tree
        .locator('[data-path="work/acme/api"] a > span')
        .first()
        .evaluate((node) => {
          const line = Number.parseFloat(getComputedStyle(node).lineHeight);
          return node.getBoundingClientRect().height <= line + 1;
        }),
    ).toBe(true);
    expect(
      await memoryRows(page).evaluateAll((rows) =>
        rows.map((r) => r.getAttribute('data-memory-row')),
      ),
    ).toEqual([1, 2, 4, 6, 3, 5, 7].map(memoryId));
    expect(await memoryRows(page).nth(2).getAttribute('data-inherited')).toBe(
      'true',
    );
    await page.getByRole('article', { name: 'Memory detail' }).waitFor();
    expect(new URL(page.url()).searchParams.get('memory')).toBe(memoryId(1));
    await memoryRows(page).nth(1).click();
    await page
      .getByRole('article', { name: 'Memory detail' })
      .getByText('Deploy staging before production.', { exact: true })
      .waitFor();
    await page.reload();
    await page
      .getByText('Deploy staging before production.', { exact: true })
      .waitFor();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
    expect(new URL(page.url()).searchParams.get('memory')).toBe(memoryId(2));
    await tree.locator('[data-path="personal"] a').click();
    await expect
      .poll(() =>
        memoryRows(page).evaluateAll((rows) =>
          rows.map((row) => row.getAttribute('data-memory-row')),
        ),
      )
      .toEqual([6, 7].map(memoryId));
    await tree
      .getByRole('button', { name: 'Collapse work', exact: true })
      .click();
    expect(await tree.locator('[data-path="work/acme"]').isVisible()).toBe(
      false,
    );
    await tree
      .getByRole('button', { name: 'Expand work', exact: true })
      .click();
    expect(await tree.locator('[data-path="work/acme"]').isVisible()).toBe(
      true,
    );
  } finally {
    await visit.close();
  }
});
it('E22: collapsing an ancestor keeps the selected bucket reachable until another bucket is chosen', async () => {
  const visit = await memoryPage(browser);
  try {
    const tree = visit.page.getByRole('navigation', { name: 'Memory buckets' });
    const selected = tree.locator('[data-path="work/acme"]');
    await selected.waitFor();
    await tree
      .getByRole('button', { name: 'Collapse work', exact: true })
      .click();
    expect(await selected.isVisible()).toBe(true);
    await tree.locator('[data-path="personal"] a').click();
    await expect.poll(() => selected.isVisible()).toBe(false);
  } finally {
    await visit.close();
  }
});
it('E23: a phone starts with the list, pushes detail and returns to the same bucket and scope without overflow', async () => {
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
    seeds: [
      memoryFixture(1, {
        content: releaseContent,
        tags: tenTags,
        workingDirectory: `/${'long-project-directory/'.repeat(80)}`,
      }),
    ],
    start: '/memory?bucket=work/acme&scope=bucket',
  });
  try {
    const { page } = visit;
    await memoryRows(page).first().waitFor();
    expect(
      await page.locator('[data-memory-list]').evaluate((node) => {
        const layout = node.closest('[data-memory-layout]');
        if (!layout) throw new Error('Memory layout is missing.');
        return (
          layout.getBoundingClientRect().width -
          node.getBoundingClientRect().width
        );
      }),
    ).toBeLessThanOrEqual(2);
    expect(
      await page.getByRole('article', { name: 'Memory detail' }).count(),
    ).toBe(0);
    await page.getByRole('link', { name: 'All buckets', exact: true }).click();
    await page
      .getByRole('navigation', { name: 'Memory buckets' })
      .locator('[data-path="work/acme"] a')
      .click();
    await memoryRows(page).first().click();
    const detail = page.getByRole('article', { name: 'Memory detail' });
    await detail.waitFor();
    expect(
      await detail.locator('[data-memory-tags] [data-slot="badge"]').count(),
    ).toBe(10);
    expect(
      await detail.locator('[data-memory-tags]').evaluate((node) => {
        const box = node.getBoundingClientRect();
        return [...node.children].every((child) => {
          const bounds = child.getBoundingClientRect();
          return bounds.left >= box.left - 1 && bounds.right <= box.right + 1;
        });
      }),
    ).toBe(true);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    expect(
      await detail
        .locator('pre')
        .evaluate((node) => node.scrollWidth > node.clientWidth),
    ).toBe(true);
    expect(
      await detail.locator('pre').evaluate((node) => {
        node.scrollLeft = 100;
        return node.scrollLeft;
      }),
    ).toBeGreaterThan(0);
    await page.getByRole('link', { name: 'Memories', exact: true }).click();
    await memoryRows(page).first().waitFor();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
    expect(new URL(page.url()).searchParams.get('scope')).toBe('bucket');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await visit.close();
  }
});
it('E24/E33: untrusted Markdown remains inert, image URLs are nonclickable and no external request is made', async () => {
  const requests: string[] = [];
  const errors: string[] = [];
  const dialogs: string[] = [];
  const visit = await memoryPage(browser, {
    configure: async (page) => {
      page.on('request', (r) => requests.push(r.url()));
      page.on('console', (m) => errors.push(m.text()));
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('dialog', (d) => {
        dialogs.push(d.message());
        void d.dismiss();
      });
    },
  });
  try {
    const { page, app } = visit;
    const detail = page.getByRole('article', { name: 'Memory detail' });
    await detail
      .getByText('Image not loaded: status', { exact: false })
      .waitFor();
    const markdown = detail.locator('[data-memory-markdown]');
    expect(await markdown.innerText()).toContain('<script>alert(1)</script>');
    expect(await markdown.innerText()).toContain(
      '<img src=x onerror=alert(1)>',
    );
    expect(await markdown.locator('img, script, iframe').count()).toBe(0);
    expect(await markdown.getByRole('table').count()).toBe(1);
    expect(
      await detail
        .getByRole('heading', { name: 'Release process', exact: true })
        .count(),
    ).toBe(1);
    expect(await markdown.locator('a').count()).toBe(1);
    const link = markdown.getByRole('link', {
      name: 'Nook releases',
      exact: true,
    });
    expect(await link.getAttribute('href')).toBe(
      'https://github.com/taecontrol/nook/releases',
    );
    expect(await link.getAttribute('target')).toBe('_blank');
    expect(await link.getAttribute('rel')).toBe('noopener noreferrer');
    expect(
      await markdown.getByRole('link', { name: /unsafe|status/ }).count(),
    ).toBe(0);
    expect(requests.every((url) => new URL(url).origin === app.origin)).toBe(
      true,
    );
    expect(errors).toEqual([]);
    expect(dialogs).toEqual([]);
  } finally {
    await visit.close();
  }
});
it('E25: detail shows reported client, authenticated principal, optional directory and absolute time', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    const detail = page.getByRole('article', { name: 'Memory detail' });
    await detail.getByText('claude-code 2.1.295', { exact: true }).waitFor();
    expect(await detail.innerText()).toContain('as reported');
    expect(await detail.innerText()).toContain('luis-mbp');
    expect(await detail.innerText()).toContain('/Users/luis/code/acme-api');
    expect(await detail.locator('time').getAttribute('datetime')).toBe(
      typicalMemories[0].createdAt,
    );
    expect(await detail.locator('time').innerText()).toMatch(
      /Oct 9, 2026.*UTC/,
    );
    await memoryRows(page).nth(2).click();
    await detail.getByText('Owner', { exact: true }).waitFor();
    expect(
      await detail.getByText('Working directory', { exact: true }).count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E26: scope is preserved in the URL and swaps the actual lineage queries', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    await page
      .getByRole('button', { name: 'Only this bucket', exact: true })
      .click();
    await expect.poll(() => memoryRows(page).count()).toBe(3);
    await page
      .getByText('3 memories · newest first', { exact: true })
      .waitFor();
    expect(new URL(page.url()).searchParams.get('scope')).toBe('bucket');
    await page.reload();
    await expect.poll(() => memoryRows(page).count()).toBe(3);
    await page
      .getByRole('button', { name: 'Include inherited', exact: true })
      .click();
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    expect(new URL(page.url()).searchParams.get('scope')).toBe('inherited');
    await page
      .getByText('7 memories · newest first', { exact: true })
      .waitFor();
  } finally {
    await visit.close();
  }
});
it('E27: a URL for a sibling memory leaves Choose a memory with no sibling content', async () => {
  const visit = await memoryPage(browser, {
    seeds: [
      ...typicalMemories,
      memoryFixture(8, {
        bucket: 'personal',
        content: '# Private sibling\nDo not show this note in work.',
      }),
    ],
    start: `/memory?bucket=work/acme&memory=${memoryId(8)}`,
  });
  try {
    const { page } = visit;
    await page.getByText('Choose a memory', { exact: true }).waitFor();
    expect(
      await page.getByRole('article', { name: 'Memory detail' }).count(),
    ).toBe(0);
    expect(await page.locator('main').innerText()).not.toContain(
      'Private sibling',
    );
  } finally {
    await visit.close();
  }
});
it('E28: a pending genuine list shows skeletons until it settles', async () => {
  const gate = deferred();
  const visit = await memoryPage(browser, {
    configure: async (page) => {
      await page.route('**/api/memories?*', async (route) => {
        const response = await route.fetch();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    await visit.page
      .getByRole('status', { name: 'Loading memories' })
      .waitFor();
    expect(
      await visit.page
        .locator('[aria-label="Loading memories"] [data-slot="skeleton"]')
        .count(),
    ).toBeGreaterThan(0);
    gate.resolve();
    await expect.poll(() => memoryRows(visit.page).count()).toBe(7);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E28: inherited-only buckets show ancestors and the bucket-only empty state', async () => {
  const visit = await memoryPage(browser, {
    start: '/memory?bucket=personal',
    seeds: typicalMemories.filter((m) => m.bucket === 'me'),
  });
  try {
    await expect.poll(() => memoryRows(visit.page).count()).toBe(2);
    await visit.page.getByRole('button', { name: 'Only this bucket' }).click();
    await visit.page
      .getByText('No memories yet', { exact: true })
      .first()
      .waitFor();
    expect(await memoryRows(visit.page).count()).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E28: the first-run empty state explains MCP remember', async () => {
  const visit = await memoryPage(browser, {
    start: '/memory?bucket=me',
    seeds: [],
  });
  try {
    await visit.page
      .getByText('Agents have not stored any memories yet.', { exact: true })
      .waitFor();
    expect(await visit.page.locator('main').innerText()).toMatch(
      /MCP.*remember|remember.*MCP/,
    );
  } finally {
    await visit.close();
  }
});
it('E28: a real failed list shows Retry and recovers after D1 is restored', async () => {
  const visit = await memoryPage(browser, {
    configure: async (_, app) => {
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
        .run();
    },
  });
  try {
    const { page } = visit;
    await page.getByText('Could not load memories', { exact: true }).waitFor();
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
      .run();
    await page.getByRole('button', { name: 'Retry', exact: true }).click();
    await expect.poll(() => memoryRows(page).count()).toBe(7);
  } finally {
    await visit.close();
  }
});
it('E29: Memory is an enabled active shell link, breadcrumb and Home tool', async () => {
  const visit = await memoryPage(browser, { start: '/' });
  try {
    const { page } = visit;
    const link = page
      .getByRole('region', { name: 'Tools', exact: true })
      .getByRole('link', { name: /Memory/ });
    await link.waitFor();
    expect(await link.getAttribute('href')).toBe('/memory');
    await link.click();
    await page.getByRole('heading', { name: 'Memory', exact: true }).waitFor();
    expect(
      await page
        .locator('[data-slot="sidebar-menu-button"]')
        .filter({ hasText: 'Memory' })
        .getAttribute('data-active'),
    ).toBe('true');
    expect(
      await page.getByRole('navigation', { name: 'breadcrumb' }).innerText(),
    ).toMatch(/Nook\s+Memory/);
  } finally {
    await visit.close();
  }
});
it('E30: row hover and keyboard focus prefetch detail before selection', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    for (const [n, action] of [
      [1, 'hover'],
      [2, 'focus'],
    ] as const) {
      const row = memoryRows(page).nth(n);
      const response = page.waitForResponse((r) =>
        r.url().endsWith(`/api/memories/${[2, 4].map(memoryId)[n - 1]}`),
      );
      if (action === 'hover') await row.hover();
      else await row.focus();
      expect((await response).status()).toBe(200);
      await row.click();
      expect(
        await page
          .getByRole('status', { name: 'Loading memory', exact: true })
          .count(),
      ).toBe(0);
      await page.getByRole('article', { name: 'Memory detail' }).waitFor();
    }
  } finally {
    await visit.close();
  }
});
it('paging: 90 memories load in four real pages and retain long title access', async () => {
  const visit = await memoryPage(browser, { seeds: manyMemories });
  try {
    const { page } = visit;
    await page
      .getByText('90 memories · newest first', { exact: true })
      .waitFor();
    for (const count of [25, 50, 75, 90]) {
      await expect.poll(() => memoryRows(page).count()).toBe(count);
      if (count < 90)
        await page
          .getByRole('button', { name: 'Load more', exact: true })
          .click();
    }
    expect((await memoryRows(page).first().getAttribute('title'))?.length).toBe(
      120,
    );
    expect(
      await page
        .getByRole('button', { name: 'Load more', exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});

it('E23: resizing from phone to desktop selects the newest memory', async () => {
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    await memoryRows(visit.page).first().waitFor();
    expect(
      await visit.page.getByRole('article', { name: 'Memory detail' }).count(),
    ).toBe(0);
    await visit.page.setViewportSize({ width: 1440, height: 900 });
    await visit.page.getByRole('article', { name: 'Memory detail' }).waitFor();
    expect(new URL(visit.page.url()).searchParams.get('memory')).toBe(
      memoryId(1),
    );
  } finally {
    await visit.close();
  }
});
it('E26/E27: an ancestor URL selection remains outside bucket-only scope', async () => {
  const visit = await memoryPage(browser, {
    seeds: [
      memoryFixture(1),
      memoryFixture(6, {
        bucket: 'me',
        content: '# Excluded ancestor\nNot in this scope.',
      }),
    ],
    start: `/memory?bucket=work/acme&scope=bucket&memory=${memoryId(6)}`,
  });
  try {
    await visit.page.getByText('Choose a memory', { exact: true }).waitFor();
    expect(
      await visit.page.getByRole('article', { name: 'Memory detail' }).count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E28: an empty lineage in a populated installation is not the first-run state', async () => {
  const visit = await memoryPage(browser, {
    seeds: [memoryFixture(1)],
    start: '/memory?bucket=personal',
  });
  try {
    await visit.page
      .getByText('Agents working in personal have no memories to read yet.', {
        exact: true,
      })
      .waitFor();
    expect(
      await visit.page
        .getByText('Agents have not stored any memories yet.', { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E28: a pending genuine detail shows its skeleton and phone back link', async () => {
  const gate = deferred();
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
    start: `/memory?bucket=work/acme&memory=${memoryId(1)}`,
    configure: async (page) => {
      await page.route(`**/api/memories/${memoryId(1)}`, async (route) => {
        const response = await route.fetch();
        await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    await visit.page
      .getByRole('status', { name: 'Loading memory', exact: true })
      .waitFor();
    expect(
      await visit.page
        .getByRole('status', { name: 'Loading memory', exact: true })
        .count(),
    ).toBe(1);
    expect(
      await visit.page
        .getByRole('link', { name: 'Memories', exact: true })
        .isVisible(),
    ).toBe(true);
    gate.resolve();
    await visit.page.getByRole('article', { name: 'Memory detail' }).waitFor();
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E28: Retry memory recovers a failed detail after real D1 recovery', async () => {
  let unavailable = false;
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
    start: `/memory?bucket=work/acme&memory=${memoryId(1)}`,
    configure: async (_, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
        .run();
      unavailable = true;
    },
  });
  try {
    await visit.page
      .getByText('Could not load memory', { exact: true })
      .waitFor();
    const retry = visit.page.getByRole('button', {
      name: 'Retry memory',
      exact: true,
    });
    expect(await retry.isVisible()).toBe(true);
    expect(
      await visit.page
        .getByRole('link', { name: 'Memories', exact: true })
        .isVisible(),
    ).toBe(true);
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
      .run();
    unavailable = false;
    await retry.click();
    await visit.page.getByRole('article', { name: 'Memory detail' }).waitFor();
  } finally {
    if (unavailable)
      await (await visit.app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
        .run();
    await visit.close();
  }
});
it('E27: a nonexistent UUID remains in Choose a memory', async () => {
  const visit = await memoryPage(browser, {
    start: `/memory?bucket=work/acme&memory=${randomUUID()}`,
  });
  try {
    await visit.page.getByText('Choose a memory', { exact: true }).waitFor();
    expect(
      await visit.page
        .getByText('Could not load memory', { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E28: Retry buckets recovers its tree after real D1 recovery', async () => {
  let unavailable = false;
  const visit = await memoryPage(browser, {
    start: `/memory?bucket=work/acme&memory=${memoryId(1)}`,
    configure: async (_, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE buckets RENAME TO unavailable_buckets')
        .run();
      unavailable = true;
    },
  });
  try {
    const retry = visit.page.getByRole('button', {
      name: 'Retry buckets',
      exact: true,
    });
    await retry.waitFor();
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE unavailable_buckets RENAME TO buckets')
      .run();
    unavailable = false;
    await retry.click();
    await visit.page
      .getByRole('navigation', { name: 'Memory buckets' })
      .locator('[data-path="work/acme"] a')
      .waitFor();
  } finally {
    if (unavailable)
      await (await visit.app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE unavailable_buckets RENAME TO buckets')
        .run();
    await visit.close();
  }
});
it('paging: a pending next page disables repeat submissions', async () => {
  const gate = deferred();
  const visit = await memoryPage(browser, {
    seeds: manyMemories,
    configure: async (page) => {
      await page.route('**/api/memories?*', async (route) => {
        const response = await route.fetch();
        if (new URL(route.request().url()).searchParams.has('cursor'))
          await gate.promise;
        await route.fulfill({ response }).catch(() => {});
      });
    },
  });
  try {
    await expect.poll(() => memoryRows(visit.page).count()).toBe(25);
    await visit.page
      .getByRole('button', { name: 'Load more', exact: true })
      .click();
    const pending = visit.page.getByRole('button', {
      name: 'Loading…',
      exact: true,
    });
    await pending.waitFor();
    expect(await pending.isDisabled()).toBe(true);
    gate.resolve();
    await expect.poll(() => memoryRows(visit.page).count()).toBe(50);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
