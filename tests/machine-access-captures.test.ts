import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  accessPage,
  editAccess,
  saveAccess,
} from './support/machine-access.ts';
import { deferred, revokeMachine } from './support/machines.ts';
import { machineRow } from './support/machines-browser.ts';

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
const scenarios = [
  'add-sibling',
  'narrow',
  'from-all',
  'missing-root',
  'unconfirmed',
  'changed-elsewhere',
  'bucket-deleted',
  'revoked',
] as const;
const matrix = scenarios.flatMap((scenario) => [
  { scenario, size: { name: 'desktop', width: 1280, height: 900 } },
  { scenario, size: { name: 'phone', width: 390, height: 844 } },
]);
it.each(matrix)(
  'E16: capture $scenario at $size.name from real Worker writes',
  async ({ scenario, size }) => {
    const gate = deferred();
    const entered = deferred();
    const visit = await accessPage(browser, {
      viewport: size,
      configure: async (page) => {
        await page.route('**/api/machines/*/grant', async (route) => {
          entered.resolve();
          await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    const { page, app } = visit;
    const errors: string[] = [];
    page.on('pageerror', (error) => errors.push(error.name));
    const shot = async (step: string) => {
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(errors).toEqual([]);
      await page.screenshot({
        path: resolve(
          directory,
          `machine-access-${scenario}-${size.name}-${step}.png`,
        ),
        animations: 'disabled',
      });
    };
    try {
      const target =
        visit.machines[
          scenario === 'narrow'
            ? 3
            : scenario === 'from-all'
              ? 1
              : scenario === 'missing-root'
                ? 5
                : 0
        ];
      await machineRow(page, target.id).waitFor();
      if (scenario === 'add-sibling') {
        await shot('list');
        await editAccess(page, visit.machines[6]);
        await shot('long-name');
        await page
          .getByRole('dialog')
          .getByRole('button', { name: 'Cancel', exact: true })
          .click();
        await page.getByRole('dialog').waitFor({ state: 'hidden' });
      }
      const sheet = await editAccess(page, target);
      await shot('opened');
      if (scenario === 'narrow')
        await sheet
          .getByRole('checkbox', {
            name: 'clients/acme-logistics',
            exact: true,
          })
          .uncheck();
      else if (scenario === 'from-all') {
        await sheet
          .getByRole('checkbox', { name: 'All buckets', exact: true })
          .uncheck();
        await sheet
          .getByRole('checkbox', { name: 'work/taecontrol/nook', exact: true })
          .check();
      } else if (scenario !== 'missing-root')
        await sheet
          .getByRole('checkbox', { name: 'work/beta', exact: true })
          .check();
      await shot('staged');
      const db = await app.mf.getD1Database('DB');
      if (scenario === 'changed-elsewhere')
        expect(
          (
            await saveAccess(
              app,
              target.id,
              ['work/acme', 'work/taecontrol'],
              ['work/acme'],
            )
          ).status,
        ).toBe(200);
      if (scenario === 'bucket-deleted')
        await db.prepare("DELETE FROM buckets WHERE path='work/beta'").run();
      if (scenario === 'revoked')
        expect((await revokeMachine(app, target.id)).status).toBe(204);
      if (scenario === 'unconfirmed')
        await db
          .prepare(
            "CREATE TRIGGER access_failure BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
          )
          .run();
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await entered.promise;
      await shot('saving');
      gate.resolve();
      if (
        [
          'unconfirmed',
          'changed-elsewhere',
          'bucket-deleted',
          'revoked',
        ].includes(scenario)
      ) {
        await sheet.getByRole('alert').waitFor();
        await expect
          .poll(() =>
            sheet.getByRole('button', { name: 'Saving…', exact: true }).count(),
          )
          .toBe(0);
        if (scenario === 'bucket-deleted')
          await sheet
            .getByRole('checkbox', { name: 'work/beta', exact: true })
            .waitFor({ state: 'hidden' });
        await shot('outcome');
        if (scenario === 'revoked') {
          await sheet
            .locator('[data-slot="sheet-footer"]')
            .getByRole('button', { name: 'Close', exact: true })
            .click();
          await sheet.waitFor({ state: 'hidden' });
          await shot('closed');
        } else {
          if (scenario === 'unconfirmed')
            await db.prepare('DROP TRIGGER access_failure').run();
          if (scenario === 'bucket-deleted') {
            expect(
              await sheet
                .getByRole('button', { name: 'Save access', exact: true })
                .isEnabled(),
            ).toBe(false);
            await sheet
              .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
              .check();
            await shot('chosen-again');
          }
          await sheet
            .getByRole('button', {
              name: scenario === 'unconfirmed' ? 'Try again' : 'Save access',
              exact: true,
            })
            .click();
          await sheet.waitFor({ state: 'hidden' });
          await shot('retried');
        }
      } else {
        await sheet.waitFor({ state: 'hidden' });
        await shot('outcome');
      }
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
