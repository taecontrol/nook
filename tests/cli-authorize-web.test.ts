import type { Browser } from 'playwright';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { deferred } from './support/machines.ts';
import { expectNoOverflow } from './support/page-checks.ts';
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
it('E21: a held lookup shows a Loading spinner and disables Continue; a held approval shows Approving…', async () => {
  const pending = await createAuthorization(app);
  const lookup = deferred();
  const approval = deferred();
  const context = await browser.newContext();
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.route('**/api/authorizations/*', async (route) => {
      await lookup.promise;
      await route.continue().catch(() => {});
    });
    await page.route('**/api/authorizations/*/approve', async (route) => {
      await approval.promise;
      await route.continue().catch(() => {});
    });
    await page.goto(`${app.origin}/cli/authorize`);
    await page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .fill(pending.userCode);
    // The busy spinner joins the button's accessible name.
    const proceed = page.getByRole('button', { name: 'Continue' });
    await proceed.click();
    await page.getByRole('status', { name: 'Loading', exact: true }).waitFor();
    expect(await proceed.isDisabled()).toBe(true);
    lookup.resolve();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('button', { name: 'Approving…' }).waitFor();
    approval.resolve();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
  } finally {
    lookup.resolve();
    approval.resolve();
    await closeBrowserPage(page, context);
  }
});
it.each([
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'phone', width: 390, height: 844 },
])(
  'E23: code entry and a long pending request fit the $name viewport with room for the brand focus ring',
  async ({ width, height }) => {
    const pending = await createAuthorization(
      app,
      'owner-laptop-with-a-deliberately-long-hostname',
    );
    const context = await browser.newContext({ viewport: { width, height } });
    const page = await context.newPage();
    const brand = page.getByRole('link', { name: 'Nook', exact: true });
    const expectBrandRoom = async () => {
      // The brand keeps its element across steps, so let transitions settle.
      await brand.evaluate((element) =>
        Promise.all(
          element
            .getAnimations()
            .map((motion) => motion.finished.catch(() => {})),
        ),
      );
      const bounds = await brand.boundingBox();
      expect(
        bounds && bounds.x >= 4 && bounds.x + bounds.width + 4 <= width,
        'Brand focus ring fits the viewport',
      ).toBe(true);
    };
    try {
      await page.goto(`${app.origin}/cli/authorize`);
      const code = page.getByRole('textbox', {
        name: 'Code from your terminal',
      });
      await code.waitFor();
      await expectNoOverflow(page);
      await expectBrandRoom();
      if (width === 390) {
        await code.focus();
        await page.keyboard.press('Shift+Tab');
        await page.keyboard.press('Shift+Tab');
        expect(
          await brand.evaluate(
            (element) =>
              element === document.activeElement &&
              element.matches(':focus-visible'),
          ),
          'Keyboard focus is visible on the brand',
        ).toBe(true);
      }
      await code.fill(pending.userCode);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Machine name', exact: true })
        .waitFor();
      await expectNoOverflow(page);
      await expectBrandRoom();
    } finally {
      await closeBrowserPage(page, context);
    }
  },
);
