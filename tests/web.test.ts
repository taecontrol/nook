import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, BrowserContext, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { observe } from '../scripts/observation.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
let app: TestRuntime;
const screenshots = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(screenshots, { recursive: true });
  app = await runtime();
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  await app?.close();
});

async function captureCoverage(page: Page) {
  if (process.env.COVERAGE_RUN) {
    await observe(
      await page.evaluate(() => ({
        seam: 'browser',
        loaded: globalThis.__authoredModules__ ?? {},
        counters: globalThis.__coverage__ ?? {},
      })),
    );
  }
}

async function closePage(page: Page, context: BrowserContext) {
  await captureCoverage(page);
  await context.close();
}

async function pageFor(status: number, email?: string, payload?: unknown) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  await page.route('**/api/whoami', (route) =>
    route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify(payload ?? (email ? { email } : {})),
    }),
  );
  await page.goto(app.origin);
  return { page, context };
}

it('E10: an expired session offers a page reload through Sign in again', async () => {
  const { page, context } = await pageFor(401);
  try {
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain('Your session has expired');
    expect(await page.locator('body').innerText()).not.toContain('@');
    const navigation = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame(),
    });
    await page
      .getByRole('button', { name: 'Sign in again', exact: true })
      .click();
    await navigation;
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain('Your session has expired');
  } finally {
    await closePage(page, context);
  }
});

it.each([
  [401, 'Unauthorized', 'Your session has expired'],
  [403, 'Forbidden', 'This account is not the owner'],
])(
  'handles the typed contract error for HTTP %s without disclosing identity',
  async (status, tag, heading) => {
    const { page, context } = await pageFor(status as number, undefined, {
      _tag: tag,
    });
    try {
      await expect
        .poll(() => page.getByRole('heading').allTextContents())
        .toContain(heading);
      expect(await page.locator('body').textContent()).not.toContain('@');
    } finally {
      await closePage(page, context);
    }
  },
);

it('a failed identity service gives a retry action without claiming a session', async () => {
  const { page, context } = await pageFor(503);
  try {
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain("We couldn't check your session");
    expect(await page.getByRole('button', { name: 'Try again' }).count()).toBe(
      1,
    );
    expect(await page.locator('body').textContent()).not.toContain('@');
    const navigation = page.waitForEvent('framenavigated', {
      predicate: (frame) => frame === page.mainFrame(),
    });
    await page.getByRole('button', { name: 'Try again' }).click();
    await navigation;
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain("We couldn't check your session");
  } finally {
    await closePage(page, context);
  }
});

it('E11: a non-owner sees no email and can sign out of Access', async () => {
  const { page, context } = await pageFor(403);
  try {
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain('This account is not the owner');
    expect(await page.locator('body').textContent()).not.toContain('@');
    await captureCoverage(page);
    const logout = page.waitForRequest(
      (request) => new URL(request.url()).pathname === '/cdn-cgi/access/logout',
    );
    await page.getByRole('link', { name: 'Sign out', exact: true }).click();
    expect(new URL((await logout).url()).pathname).toBe(
      '/cdn-cgi/access/logout',
    );
  } finally {
    await closePage(page, context);
  }
});

it('E12: a pending identity never claims the owner or displays an email', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route('**/api/whoami', async (route) => {
    await pending;
    await route
      .fulfill({ status: 401, contentType: 'application/json', body: '{}' })
      .catch(() => {});
  });
  try {
    await page.goto(app.origin);
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain('Checking your session');
    expect(await page.locator('body').textContent()).not.toContain('@');
    expect(
      await page.getByRole('button', { name: 'Sign in again' }).count(),
    ).toBe(0);
    expect(await page.getByRole('button', { name: 'Try again' }).count()).toBe(
      0,
    );
  } finally {
    release?.();
    await closePage(page, context);
  }
});

it('follows a changed OS color scheme without reloading the document', async () => {
  const context = await browser.newContext({ colorScheme: 'light' });
  const page = await context.newPage();
  let requests = 0;
  await page.route('**/api/whoami', (route) => {
    requests++;
    return route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'owner@nook.test' }),
    });
  });
  const dark = () =>
    page.evaluate(() => document.documentElement.classList.contains('dark'));
  try {
    await page.goto(app.origin);
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain("You're signed in");
    expect(await dark()).toBe(false);
    await page.emulateMedia({ colorScheme: 'dark' });
    await expect.poll(dark).toBe(true);
    await page.emulateMedia({ colorScheme: 'light' });
    await expect.poll(dark).toBe(false);
    expect(requests).toBe(1);
  } finally {
    await closePage(page, context);
  }
});

it('E13: a cold open calls only whoami once through history, menu and focus interactions', async () => {
  const context = await browser.newContext();
  const page = await context.newPage();
  const apiRequests: string[] = [];
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.startsWith('/api/')) apiRequests.push(path);
  });
  await page.route('**/api/whoami', (route) =>
    route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ email: 'owner@nook.test' }),
    }),
  );
  try {
    await page.goto(app.origin);
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain("You're signed in");
    // Same-document history, menu and focus interactions preserve the cold-open
    // request count. The real QueryClient keeper separately proves cache reuse.
    await page.evaluate(() => {
      history.pushState(null, '', '/?visit=2');
      dispatchEvent(new PopStateEvent('popstate'));
    });
    await page.getByRole('button', { name: /Owner/ }).click();
    await expect
      .poll(() => page.getByRole('menuitem', { name: 'Sign out' }).count())
      .toBe(1);
    await page.keyboard.press('Escape');
    await page.bringToFront();
    await expect
      .poll(() => page.getByRole('heading').allTextContents())
      .toContain("You're signed in");
    expect(apiRequests).toEqual(['/api/whoami']);
  } finally {
    await closePage(page, context);
  }
});

const visualStates = [
  {
    name: 'signed-in',
    status: 200,
    email: 'owner@nook.test',
    heading: "You're signed in",
  },
  {
    name: 'long-email',
    status: 200,
    email: 'a.deliberately.long.mailbox.name@engineering.example.com',
    heading: "You're signed in",
  },
  { name: 'loading', status: 0, heading: 'Checking your session' },
  { name: 'session-expired', status: 401, heading: 'Your session has expired' },
  { name: 'not-owner', status: 403, heading: 'This account is not the owner' },
];
const visualMatrix = visualStates.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);

async function expectNoOverflow(page: Page) {
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    card: document
      .querySelector('[data-slot="card"]')
      ?.getBoundingClientRect()
      .toJSON(),
  }));
  expect(layout.scroll).toBe(layout.width);
  expect(layout.card?.left).toBeGreaterThanOrEqual(0);
  expect(layout.card?.right).toBeLessThanOrEqual(layout.width);
}

it.each(visualMatrix)(
  'E15: $size.name $state.name $theme matches the shell without clipping',
  async ({ state, theme, size }) => {
    const context = await browser.newContext({
      viewport: size,
      colorScheme: theme,
    });
    const page = await context.newPage();
    let release = () => {};
    const pending = new Promise<void>((accept) => {
      release = accept;
    });
    await page.route('**/api/whoami', async (route) => {
      if (!state.status) {
        await pending;
        await route.abort().catch(() => {});
        return;
      }
      await route.fulfill({
        status: state.status,
        contentType: 'application/json',
        body: JSON.stringify(
          state.email
            ? { email: state.email }
            : { _tag: state.status === 401 ? 'Unauthorized' : 'Forbidden' },
        ),
      });
    });
    const name = `${size.name}-${state.name}-${theme}`;
    try {
      await page.goto(app.origin);
      await expect
        .poll(() => page.getByRole('heading').allTextContents())
        .toContain(state.heading);
      expect(
        await page.evaluate(() =>
          document.documentElement.classList.contains('dark'),
        ),
      ).toBe(theme === 'dark');
      await expectNoOverflow(page);
      if (state.email) {
        expect(
          await page.getByRole('region', { name: 'Owner access' }).innerText(),
        ).toContain(state.email);
      } else {
        expect(await page.locator('body').textContent()).not.toContain('@');
      }
      if (state.name === 'long-email') {
        const breaks = await page
          .getByRole('region', { name: 'Owner access' })
          .getByText(String(state.email), { exact: true })
          .evaluate((element) => {
            const characters: { text: string; top: number }[] = [];
            const walker = document.createTreeWalker(
              element,
              NodeFilter.SHOW_TEXT,
            );
            for (let node = walker.nextNode(); node; node = walker.nextNode()) {
              for (
                let offset = 0;
                offset < (node.textContent?.length ?? 0);
                offset++
              ) {
                const range = document.createRange();
                range.setStart(node, offset);
                range.setEnd(node, offset + 1);
                characters.push({
                  text: node.textContent?.[offset] ?? '',
                  top: range.getBoundingClientRect().top,
                });
              }
            }
            return characters.flatMap((character, index) =>
              index && character.top !== characters[index - 1].top
                ? [characters[index - 1].text]
                : [],
            );
          });
        if (size.name === 'mobile') expect(breaks.length).toBeGreaterThan(0);
        expect(breaks.every((separator) => /[@._-]/.test(separator))).toBe(
          true,
        );
      }
      await page.screenshot({
        path: resolve(screenshots, `${name}.png`),
        animations: 'disabled',
      });
      if (size.name === 'mobile') {
        await page.getByRole('button', { name: 'Toggle Sidebar' }).click();
        await expect
          .poll(() => page.getByRole('dialog').isVisible())
          .toBe(true);
      }
      expect(
        await page
          .getByRole('button', { name: 'Memory Not available yet' })
          .isDisabled(),
      ).toBe(true);
      expect(
        await page
          .getByRole('button', { name: 'Vault Not available yet' })
          .isDisabled(),
      ).toBe(true);
      if (state.name === 'long-email') {
        if (size.name === 'mobile')
          await page.screenshot({
            path: resolve(screenshots, `${name}-sheet.png`),
            animations: 'disabled',
          });
        await page.getByRole('button', { name: 'Owner account' }).click();
        await expect.poll(() => page.getByRole('menu').isVisible()).toBe(true);
        expect(await page.getByRole('menu').innerText()).toContain(state.email);
        expect(
          await page
            .getByRole('menuitem', { name: 'Sign out' })
            .getAttribute('href'),
        ).toBe('/cdn-cgi/access/logout');
        const menu = await page.getByRole('menu').boundingBox();
        expect(menu?.x).toBeGreaterThanOrEqual(0);
        expect((menu?.x ?? 0) + (menu?.width ?? 0)).toBeLessThanOrEqual(
          size.width,
        );
        await page.screenshot({
          path: resolve(screenshots, `${name}-user-menu.png`),
          animations: 'disabled',
        });
      }
    } finally {
      await closePage(page, context);
      release();
    }
  },
);
