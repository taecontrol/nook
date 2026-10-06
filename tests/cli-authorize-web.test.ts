import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
let app: TestRuntime;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  return () => app.close();
});
it('E20: query-string codes never prefill or reveal a request', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const lookups: string[] = [];
  page.on('request', (request) => {
    if (request.url().includes('/api/authorizations/'))
      lookups.push(request.url());
  });
  try {
    await page.goto(`${app.origin}/cli/authorize?code=WDJB-MJHT`);
    const field = page.getByRole('textbox', {
      name: 'Code from your terminal',
    });
    await field.waitFor();
    expect(await field.inputValue()).toBe('');
    expect(
      await page
        .getByRole('heading', { name: 'Approve this machine?' })
        .count(),
    ).toBe(0);
    expect(lookups).toEqual([]);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it.each(['lowercase', 'spaces', 'no-hyphen'])(
  'E21: a %s code reveals only a matching pending request in one request and focuses its name',
  async (variation) => {
    const pending = await createAuthorization(app);
    const code =
      variation === 'lowercase'
        ? pending.userCode.toLowerCase()
        : variation === 'spaces'
          ? ` ${pending.userCode.replace('-', ' ')} `
          : pending.userCode.replace('-', '');
    const context = await browser.newContext();
    const page = await context.newPage();
    const lookups: string[] = [];
    page.on('request', (request) => {
      if (request.url().includes('/api/authorizations/'))
        lookups.push(request.url());
    });
    try {
      await page.goto(`${app.origin}/cli/authorize`);
      await page
        .getByRole('textbox', { name: 'Code from your terminal' })
        .fill(code);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      const name = page.getByRole('textbox', {
        name: 'Machine name',
        exact: true,
      });
      await name.waitFor();
      expect(
        await name.evaluate((field) => field === document.activeElement),
      ).toBe(true);
      expect(await name.inputValue()).toBe('synthetic-machine');
      expect(
        await page.getByText(pending.userCode, { exact: true }).count(),
      ).toBe(1);
      expect(
        await page.getByRole('button', { name: 'Change', exact: true }).count(),
      ).toBe(1);
      for (const text of ['Bucket access', 'Client', 'Requested', 'Expires'])
        expect(await page.getByText(text, { exact: true }).count()).toBe(1);
      expect(lookups).toHaveLength(1);
      await name.press('Enter');
      await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    } finally {
      await closeBrowserPage(page, context);
    }
  },
);
it('E21: an unknown code stays on step one with an error and restores code focus', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  try {
    await page.goto(`${app.origin}/cli/authorize`);
    const field = page.getByRole('textbox', {
      name: 'Code from your terminal',
    });
    await field.fill('WDJB-MJHT');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page.getByText('No matching request', { exact: true }).waitFor();
    expect(
      await page.getByRole('textbox', { name: 'Machine name' }).count(),
    ).toBe(0);
    expect(
      await field.evaluate((input) => input === document.activeElement),
    ).toBe(true);
  } finally {
    await closeBrowserPage(page, context);
  }
});
it.each(['expired', 'handled'])(
  'E22: a %s code shows its result card with no form',
  async (state) => {
    const pending = await createAuthorization(app);
    if (state === 'expired')
      await (await app.mf.getD1Database('DB'))
        .prepare('UPDATE authorizations SET expires_at=0')
        .run();
    else expect((await approve(app, pending.userCode)).status).toBe(204);
    const context = await browser.newContext();
    const page = await context.newPage();
    try {
      await page.goto(`${app.origin}/cli/authorize`);
      await page
        .getByRole('textbox', { name: 'Code from your terminal' })
        .fill(pending.userCode);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page
        .getByRole('heading', {
          name:
            state === 'expired'
              ? 'This request expired'
              : 'This request was already handled',
          exact: true,
        })
        .waitFor();
      expect(await page.locator('form').count()).toBe(0);
    } finally {
      await closeBrowserPage(page, context);
    }
  },
);
