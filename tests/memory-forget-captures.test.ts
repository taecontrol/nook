import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  typicalMemories,
} from './support/memory.ts';
import {
  confirmForget,
  forgetDialog,
  forgetPage,
  forgottenId,
  openForget,
} from './support/memory-forget.ts';
import type { TestRuntime } from './support/runtime.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
const directory = resolve('.local/verification/screenshots');
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
const states = [
  'pane-menu',
  'row-menu',
  'confirm',
  'forgetting',
  'forgotten',
  'failed',
  'changed',
  'last',
  'search',
  'inherited',
] as const;
type State = (typeof states)[number];
const sizes = [
  { width: 1440, height: 900, name: 'desktop', theme: 'light' },
  { width: 1440, height: 900, name: 'desktop', theme: 'dark' },
  { width: 390, height: 844, name: 'phone', theme: 'light' },
] as const;
async function newer(app: TestRuntime) {
  const client = memoryClient(app, '2026-07-28');
  const current = (await client.call('get', { id: forgottenId }))
    .structuredContent;
  expect(
    (
      await client.call('update', {
        id: forgottenId,
        expectedVersion: 3,
        content: current?.content,
        tags: ['deploy', 'release-process', 'cli', 'freeze'],
      })
    ).isError,
  ).not.toBe(true);
}
async function present(
  page: Page,
  app: TestRuntime,
  state: State,
  phone: boolean,
) {
  if (state === 'row-menu') {
    if (phone)
      await page.getByRole('link', { name: 'Memories', exact: true }).click();
    await page.locator(`[data-memory-actions="${memoryId(2)}"]`).click();
    await page.getByRole('menuitem', { name: 'Forget memory…' }).waitFor();
    return;
  }
  if (state === 'pane-menu') {
    await page
      .getByRole('button', { name: 'More actions', exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Forget memory…' }).waitFor();
    return;
  }
  if (state === 'search') {
    if (phone)
      await page.getByRole('link', { name: 'Results', exact: true }).click();
    await openForget(page, memoryId(5));
    await expect
      .poll(() =>
        forgetDialog(page)
          .getByRole('button', { name: 'Forget memory', exact: true })
          .isEnabled(),
      )
      .toBe(true);
    return;
  }
  await openForget(page);
  if (['confirm', 'search', 'inherited'].includes(state)) return;
  if (state === 'changed') await newer(app);
  if (state === 'forgetting' || state === 'forgotten') {
    await forgetDialog(page)
      .getByRole('button', { name: 'Forget memory', exact: true })
      .focus();
    await page.keyboard.press('Enter');
  } else await confirmForget(page);
  await outcome(page, state);
}
async function outcome(page: Page, state: State) {
  if (state === 'forgetting')
    await page
      .getByText('Forgetting Release process…', { exact: true })
      .waitFor();
  else if (state === 'failed')
    await page
      .getByRole('alert')
      .filter({ hasText: 'Not forgotten' })
      .waitFor();
  else if (state === 'changed')
    await page.getByRole('button', { name: 'Forget version 4…' }).waitFor();
  else if (state === 'last')
    await page.getByText('No memories left', { exact: true }).waitFor();
  else
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
}
function captureTarget(state: State) {
  if (state === 'inherited') return memoryId(6);
  if (state === 'last') return memoryId(8);
  return state === 'search' ? memoryId(2) : forgottenId;
}
it.each(states.flatMap((state) => sizes.map((size) => ({ state, size }))))(
  'E23: capture $state at $size.name $size.theme against hybrid B+C',
  async ({ state, size }) => {
    const gate = deferred();
    const target = captureTarget(state);
    const bucket = state === 'last' ? 'work/acme/api' : 'work/acme';
    const visit = await forgetPage(browser, {
      viewport: size,
      colorScheme: size.theme,
      ...(state === 'last'
        ? {
            seeds: [
              ...typicalMemories,
              memoryFixture(8, {
                bucket,
                content: '# API rate limits\nUse per-token limits on writes.',
              }),
            ],
          }
        : {}),
      start: `/memory?bucket=${bucket}&memory=${target}${state === 'search' ? '&q=deploy' : state === 'last' ? '&scope=bucket' : ''}`,
      configure: async (page, app) => {
        if (state === 'forgetting')
          await page.route(
            '**/api/memories/*?expectedVersion=*',
            async (route) => {
              await gate.promise;
              await route.continue().catch(() => {});
            },
          );
        if (state === 'failed')
          await (await app.mf.getD1Database('DB'))
            .prepare(
              "CREATE TRIGGER synthetic_forget_failure BEFORE DELETE ON memories BEGIN SELECT RAISE(ABORT,'synthetic failure'); END",
            )
            .run();
      },
    });
    try {
      const { page, app } = visit;
      await page.getByRole('article', { name: 'Memory detail' }).waitFor();
      await present(page, app, state, size.name === 'phone');
      if (state === 'forgetting' && size.name === 'desktop')
        await page
          .getByRole('article', { name: 'Memory detail' })
          .getByRole('heading', { name: 'Acme API deployment', exact: true })
          .waitFor();
      if (
        ['forgetting', 'forgotten'].includes(state) &&
        size.name === 'desktop'
      )
        await expect
          .poll(() =>
            page
              .locator(`[data-memory-row="${memoryId(2)}"]`)
              .evaluate((el) => document.activeElement === el),
          )
          .toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      if (['confirm', 'search', 'inherited'].includes(state))
        expect(await forgetDialog(page).textContent()).toContain(
          'What is deleted',
        );
      await page.screenshot({
        path: resolve(
          directory,
          `memory-forget-${state}--${size.name}-${size.theme}.png`,
        ),
        animations: 'disabled',
      });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
  30_000,
);
