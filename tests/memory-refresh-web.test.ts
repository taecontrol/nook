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
