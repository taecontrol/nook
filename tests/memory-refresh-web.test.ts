import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import {
  memoryClient,
  memoryId,
  memoryRows,
  memoryRuntime,
  seedMemories,
} from './support/memory.ts';
import { visibilityBrowser } from './support/visibility-browser.ts';

it('E30: an agent write appears after real tab refocus without reloading', async () => {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  try {
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedMemories(app);
    await page.goto(
      `${app.origin}/memory?bucket=work/acme&memory=${memoryId(1)}`,
    );
    await expect.poll(() => memoryRows(page).count()).toBe(7);
    await page.getByRole('article', { name: 'Memory detail' }).waitFor();
    const bucket = page
      .getByRole('navigation', { name: 'Memory buckets' })
      .locator('[data-path="work/acme"]');
    await expect.poll(() => bucket.innerText()).toContain('3 memories');
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    const result = await memoryClient(app, '2026-07-28').call('remember', {
      bucket: 'work/acme',
      content: '# New from an agent\nAppears on refocus.',
    });
    expect(result.isError).not.toBe(true);
    await page.bringToFront();
    await expect.poll(() => memoryRows(page).count()).toBe(8);
    expect(await memoryRows(page).first().innerText()).toContain(
      'New from an agent',
    );
    await expect.poll(() => bucket.innerText()).toContain('4 memories');
    await page
      .getByText('8 memories · newest first', { exact: true })
      .waitFor();
  } finally {
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});

it('E11/E30: a fresh active search includes an agent write after real tab refocus', async () => {
  const app = await memoryRuntime();
  const visible = await visibilityBrowser();
  const { page, context } = visible;
  let requests = 0;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/memories/search') requests++;
  });
  try {
    // Keep the query fresh deterministically; native visibility is still real.
    await page.clock.setFixedTime(new Date('2026-10-10T20:00:00Z'));
    await page.setViewportSize({ width: 1440, height: 900 });
    await seedMemories(app);
    await page.goto(`${app.origin}/memory?bucket=work/acme&q=publicar`);
    await page.locator('[data-search-result]').first().waitFor();
    expect(requests).toBe(1);
    const other = await context.newPage();
    await other.bringToFront();
    await expect
      .poll(() => page.evaluate(() => document.visibilityState))
      .toBe('hidden');
    const result = await memoryClient(app, '2026-07-28').call('remember', {
      bucket: 'work/acme',
      content:
        '# Fresh publication\n\nPara publicar una versión nueva, lanzar el flujo de publicación cuando la integración continua esté en verde.',
    });
    expect(result.isError).not.toBe(true);
    const { id } = result.structuredContent as { id: string };
    await page.bringToFront();
    await expect.poll(() => requests).toBe(2);
    await page.locator(`[data-search-result="${id}"]`).waitFor();
    expect(new URL(page.url()).searchParams.get('q')).toBe('publicar');
  } finally {
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});
