import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { runtime } from './support/runtime.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
const directory = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const states = [
  'enter-code',
  'pending',
  'pending-long',
  'loading',
  'name-empty',
  'approving',
  'approved',
  'denied',
  'expired',
  'unknown',
  'used',
  'approve-failed',
];
const matrix = states.flatMap((state) =>
  (['pending', 'approved', 'expired'].includes(state)
    ? (['light', 'dark'] as const)
    : (['light'] as const)
  ).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
it.each(matrix)(
  'E23: capture $state $size.name $theme without overflow or clipped brand focus',
  async ({ state, theme, size }) => {
    const app = await ownerRuntime(await runtime());
    const context = await browser.newContext({
      viewport: size,
      colorScheme: theme,
    });
    const page = await context.newPage();
    let release = () => {};
    try {
      const name =
        state === 'pending-long'
          ? 'owner-laptop-with-a-deliberately-long-hostname'
          : 'omarchy';
      await createAuthorization(app, name);
      const db = await app.mf.getD1Database('DB');
      const now = Date.now();
      await db
        .prepare(
          "UPDATE authorizations SET user_code='WDJB-MJHT', requested_at=?, expires_at=?",
        )
        .bind(now - 119_000, now + 480_000)
        .run();
      if (state === 'expired')
        await db.prepare('UPDATE authorizations SET expires_at=0').run();
      if (state === 'used')
        expect((await approve(app, 'WDJB-MJHT')).status).toBe(204);
      if (state === 'loading' || state === 'approving') {
        const waiting = new Promise<void>((accept) => {
          release = accept;
        });
        const route =
          state === 'loading'
            ? '**/api/authorizations/WDJBMJHT'
            : '**/api/authorizations/WDJBMJHT/approve';
        await page.route(route, async (route) => {
          await waiting;
          await route.abort().catch(() => {});
        });
      }
      if (state === 'approve-failed')
        await page.route('**/api/authorizations/*/approve', (route) =>
          route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
        );
      await page.goto(`${app.origin}/cli/authorize`);
      const code = page.getByRole('textbox', {
        name: 'Code from your terminal',
      });
      await code.waitFor();
      if (state !== 'enter-code') {
        await code.fill(state === 'unknown' ? 'KXTR-PQNM' : 'WDJB-MJHT');
        await page
          .getByRole('button', { name: 'Continue', exact: true })
          .click();
        if (state === 'loading')
          await page
            .getByRole('status', { name: 'Loading', exact: true })
            .waitFor();
        else if (state === 'unknown')
          await page
            .getByText('No matching request', { exact: true })
            .waitFor();
        else if (state === 'expired' || state === 'used')
          await page
            .getByRole('heading', {
              name:
                state === 'expired'
                  ? 'This request expired'
                  : 'This request was already handled',
              exact: true,
            })
            .waitFor();
        else {
          const field = page.getByRole('textbox', {
            name: 'Machine name',
            exact: true,
          });
          await field.waitFor();
          if (state === 'name-empty') {
            await field.fill('');
            await field.press('Enter');
            await page
              .getByText('Enter a name for this machine.', { exact: true })
              .waitFor();
          }
          if (['approving', 'approved', 'approve-failed'].includes(state)) {
            await page
              .getByRole('button', { name: 'Approve', exact: true })
              .click();
          }
          if (state === 'approving')
            await page.getByRole('button', { name: 'Approving…' }).waitFor();
          if (state === 'approved')
            await page
              .getByRole('heading', { name: 'Machine approved', exact: true })
              .waitFor();
          if (state === 'approve-failed')
            await page
              .getByText("Couldn't reach Nook", { exact: true })
              .waitFor();
          if (state === 'denied') {
            await page
              .getByRole('button', { name: 'Deny', exact: true })
              .click();
            await page
              .getByRole('heading', { name: 'Request denied', exact: true })
              .waitFor();
          }
        }
      }
      expect(
        await page.evaluate(
          () => document.documentElement.scrollWidth <= innerWidth,
        ),
      ).toBe(true);
      const brand = page.getByRole('link', { name: 'Nook', exact: true });
      const bounds = await brand.boundingBox();
      expect(
        bounds && bounds.x >= 4 && bounds.x + bounds.width + 4 <= size.width,
        'Brand focus ring fits the viewport',
      ).toBe(true);
      await page.screenshot({
        path: resolve(
          directory,
          `cli-authorize-${state}-${size.name}-${theme}.png`,
        ),
        fullPage: true,
        animations: 'disabled',
      });
      if (size.name === 'mobile' && state === 'enter-code') {
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
        await page.screenshot({
          path: resolve(
            directory,
            'cli-authorize-brand-focus-mobile-light.png',
          ),
          fullPage: true,
          animations: 'disabled',
        });
      }
    } finally {
      release();
      await closeBrowserPage(page, context);
      await app.close();
    }
  },
);
