import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import { ownerRuntime } from './support/authorizations.ts';
import { issueGrant, seedGrantTree } from './support/grants.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  await issueGrant(app, ['work/acme']);
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  await app?.close();
});

it('E17: the production editor timing measures its rendered checked tree on the 390 px phone', async () => {
  const { context, page } = await phonePage(browser, 'machineAccessNavigation');
  try {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    const measured = await measureScreen(
      page,
      app.origin,
      '',
      'machineAccessNavigation',
    );
    expect(Number.isFinite(measured)).toBe(true);
    expect(measured).toBeGreaterThanOrEqual(0);
    expect(new URL(page.url()).pathname).toBe('/machines');
    const sheet = page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    expect(await sheet.isVisible()).toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'me', exact: true })
        .isVisible(),
    ).toBe(true);
  } finally {
    await context.close();
  }
});
