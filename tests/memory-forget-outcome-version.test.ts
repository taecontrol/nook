import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryClient } from './support/memory.ts';
import {
  confirmForget,
  forgetPage,
  forgottenId,
  openForget,
} from './support/memory-forget.ts';

it('a held Check again response cannot replace a newer cached memory version', async () => {
  const browser = await launchTestBrowser();
  const visit = await forgetPage(browser.browser);
  const gate = deferred();
  const arrived = deferred();
  let reads = 0;
  let checkedMemory: unknown;
  try {
    const { page, app } = visit;
    await page.getByRole('button', { name: /History.*3 versions/ }).waitFor();
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.abort(),
    );
    await page.route(`**/api/memories/${forgottenId}`, async (route) => {
      if (++reads === 1) {
        await route.abort();
        return;
      }
      const response = await route.fetch();
      if (reads === 2) {
        checkedMemory = await response.json();
        arrived.resolve();
        await gate.promise;
      }
      await route.fulfill({ response }).catch(() => {});
    });
    await confirmForget(page);
    const unknown = page
      .getByRole('alert')
      .filter({ hasText: 'Forget not confirmed' });
    await unknown.getByRole('button', { name: 'Check again' }).click();
    await arrived.promise;
    expect(checkedMemory).toMatchObject({ version: 3 });
    expect(
      (
        await memoryClient(app, '2026-07-28').call('update', {
          id: forgottenId,
          expectedVersion: 3,
          content: '# Release process\nThe latest release process.',
        })
      ).isError,
    ).not.toBe(true);
    await page.locator(`[data-memory-row="${forgottenId}"]`).click();
    const history = page.getByRole('button', { name: /History.*4 versions/ });
    await history.waitFor();
    const checked = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === `/api/memories/${forgottenId}`,
    );
    gate.resolve();
    await (await checked).finished();
    await page.getByText('Not forgotten', { exact: true }).waitFor();
    expect(await history.count()).toBe(1);
    expect(
      await page.getByRole('article', { name: 'Memory detail' }).textContent(),
    ).toContain('The latest release process.');
  } finally {
    gate.resolve();
    await visit.close();
    await browser.close();
  }
});
