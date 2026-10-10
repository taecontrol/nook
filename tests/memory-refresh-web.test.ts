import { expect, it } from 'vitest';
import { observeBrowserPage } from './support/buckets-browser.ts';
import {
  memoryClient,
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
    await seedMemories(app);
    await page.goto(`${app.origin}/memory?bucket=work/acme`);
    await expect.poll(() => memoryRows(page).count()).toBe(7);
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
  } finally {
    await observeBrowserPage(page);
    await visible.close();
    await app.close();
  }
});
