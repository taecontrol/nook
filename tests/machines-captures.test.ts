import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred, manyMachines, typicalMachines } from './support/machines.ts';
import {
  confirmRevoke,
  machineRow,
  machinesPage,
} from './support/machines-browser.ts';
import type { TestRuntime } from './support/runtime.ts';

const directory = resolve('.local/verification/screenshots');
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const states = [
  'typical',
  'single-new',
  'empty',
  'many-long',
  'loading',
  'load-error',
  'confirm',
  'revoking',
  'revoked',
  'revoke-failed',
] as const;
const matrix = states.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);

async function configureState(
  page: Page,
  app: TestRuntime,
  state: (typeof states)[number],
  gate: ReturnType<typeof deferred>,
) {
  const db = await app.mf.getD1Database('DB');
  if (state === 'load-error')
    await db
      .prepare(
        'ALTER TABLE machine_tokens RENAME TO unavailable_machine_tokens',
      )
      .run();
  if (state === 'revoke-failed')
    await db
      .prepare(
        "CREATE TRIGGER revoke_failure BEFORE DELETE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
      )
      .run();
  if (state === 'loading' || state === 'revoking')
    await page.route(
      state === 'loading' ? '**/api/machines' : '**/api/machines/*',
      async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      },
    );
}
it.each(matrix)(
  'E26: capture $state $size.name $theme from the built Machines product',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const visit = await machinesPage(browser, {
      seeds:
        state === 'single-new'
          ? [typicalMachines[4]]
          : state === 'empty'
            ? []
            : state === 'many-long'
              ? manyMachines
              : typicalMachines,
      viewport: size,
      colorScheme: theme,
      configure: (page, app) => configureState(page, app, state, gate),
    });
    const { page } = visit;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    try {
      await page
        .getByRole('heading', { name: 'Machines', exact: true })
        .waitFor();
      if (state === 'loading')
        await page.getByRole('status', { name: 'Loading machines' }).waitFor();
      else if (state === 'load-error')
        await page
          .getByText("Couldn't load machines", { exact: true })
          .waitFor();
      else if (state === 'empty')
        await page
          .getByText('No machines connected', { exact: true })
          .waitFor();
      else await machineRow(page, visit.machines[0].id).waitFor();
      const target = visit.machines[2];
      if (state === 'confirm') {
        await machineRow(page, target.id)
          .getByRole('button', { name: /Revoke/ })
          .click();
        await page.getByRole('alertdialog').waitFor();
      }
      if (
        state === 'revoking' ||
        state === 'revoked' ||
        state === 'revoke-failed'
      ) {
        const response =
          state === 'revoking'
            ? undefined
            : page.waitForResponse(
                (response) => response.request().method() === 'DELETE',
              );
        await confirmRevoke(page, target.id);
        if (response)
          expect((await response).status()).toBe(
            state === 'revoke-failed' ? 503 : 204,
          );
        await expect
          .poll(() => page.getByRole('alert').innerText())
          .toContain(
            state === 'revoking'
              ? 'Revoking framework-13…'
              : state === 'revoke-failed'
                ? "Couldn't confirm revocation of framework-13"
                : 'Revoked framework-13',
          );
        expect(await machineRow(page, target.id).count()).toBe(
          state === 'revoke-failed' ? 1 : 0,
        );
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(
        await page
          .getByRole('button', { name: /Scenarios|Reset|next revoke fails/i })
          .count(),
      ).toBe(0);
      expect(errors).toEqual([]);
      const filename = `machines-${state}-${size.name}-${theme}`;
      await page.screenshot({
        path: resolve(directory, `${filename}.png`),
        animations: 'disabled',
      });
      if (
        state === 'many-long' ||
        (state === 'typical' && size.name === 'mobile')
      )
        await page.screenshot({
          path: resolve(directory, `${filename}-full.png`),
          animations: 'disabled',
          fullPage: true,
        });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
