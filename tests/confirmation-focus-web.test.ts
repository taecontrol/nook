import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { manyMachines } from './support/machines.ts';
import { machineRow, machinesPage } from './support/machines-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

it('closing a confirmation returns focus without scrolling an offscreen trigger into view', async () => {
  const visit = await machinesPage(browser, {
    seeds: manyMachines,
    viewport: { width: 1440, height: 300 },
  });
  try {
    const { page, machines } = visit;
    const trigger = machineRow(page, machines[0].id).getByRole('button', {
      name: /Revoke/,
      includeHidden: true,
    });
    await trigger.click();
    const dialog = page.getByRole('alertdialog');
    await dialog.waitFor();
    // The document can move while its modal is open (for example, after layout
    // changes). Restoring focus must preserve that new reading position.
    const top = await page.evaluate(() => {
      window.scrollTo(0, document.documentElement.scrollHeight);
      return window.scrollY;
    });
    expect(top).toBeGreaterThan(0);
    expect(
      await trigger.evaluate((el) => el.getBoundingClientRect().bottom),
    ).toBeLessThan(0);
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    await expect
      .poll(() => trigger.evaluate((el) => document.activeElement === el))
      .toBe(true);
    expect(await page.evaluate(() => window.scrollY)).toBe(top);
  } finally {
    await visit.close();
  }
});
