import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../../scripts/lib/test-browser.ts';
import { d1Now, dayMs } from '../support/access-expiry.ts';
import { bucketCheck, grantPage } from '../support/grant-browser.ts';
import { seedGrantTree } from '../support/grants.ts';
import { machineRow, machinesPage } from '../support/machines-browser.ts';
import type { TestRuntime } from '../support/runtime.ts';

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
const matrix = ['request', 'approved', 'machines', 'removed'].flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
const seeds = [
  ['codex-cloud-task-2b91', 8, 7, -1, ['me/despensa']],
  ['old-hetzner-vps', 120, 95, -30, ['work']],
  ['lg32', 75, 41, null, 'all'],
  ['raspberry-pi-garage', 0, null, 30, ['me/despensa']],
  ['lg-omarchy', 62, 0, null, 'all'],
  ['ci-sandbox-7f3a', 1, 0, 1 / 24, ['me/nook']],
  ['lg16', 20, 2, 10, ['me', 'work/mamasan']],
] as const;
async function captureMachines(page: Page, app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  for (const [name, approved, used, expiry, grant] of seeds) {
    await db
      .prepare(
        "UPDATE machine_tokens SET created_at=CAST(unixepoch('subsec')*1000 AS INTEGER)-?1, last_used_at=CASE WHEN ?2 IS NULL THEN NULL ELSE CAST(unixepoch('subsec')*1000 AS INTEGER)-?2 END, grant_json=?3 WHERE machine_name=?4",
      )
      .bind(
        approved * dayMs || 3_600_000,
        used === null ? null : used * dayMs || 240_000,
        JSON.stringify(grant),
        name,
      )
      .run();
    await db
      .prepare(
        "UPDATE machine_tokens SET access_expires_at=CASE WHEN ?1 IS NULL THEN NULL ELSE CAST(unixepoch('subsec')*1000 AS INTEGER)+?1 END WHERE machine_name=?2",
      )
      .bind(expiry === null ? null : expiry * dayMs, name)
      .run();
  }
  await page.clock.setFixedTime(new Date(await d1Now(app)));
}
it.each(matrix)(
  'Expiry E15: capture $state $size.name $theme from the built product',
  async ({ state, theme, size }) => {
    const machineState = state === 'machines' || state === 'removed';
    const visit = machineState
      ? await machinesPage(browser, {
          seeds: seeds.map(([name]) => ({
            name,
            approvedAt: '2026-10-01T12:00:00Z',
            lastUsedAt: null,
          })),
          viewport: size,
          colorScheme: theme,
          configure: captureMachines,
        })
      : await grantPage(browser, {
          viewport: size,
          colorScheme: theme,
          configure: async (_page, app) => {
            const db = await app.mf.getD1Database('DB');
            await db.prepare("DELETE FROM buckets WHERE path<>'me'").run();
            await seedGrantTree(app, [
              'me',
              'me/despensa',
              'me/nook',
              'me/writing',
              'work',
              'work/mamasan',
              'work/mamasan/local',
            ]);
            await db
              .prepare(
                "UPDATE authorizations SET suggested_name='ci-sandbox-7f3a'",
              )
              .run();
          },
        });
    const { page } = visit;
    try {
      if ('reveal' in visit) {
        await visit.reveal();
        await bucketCheck(page, 'me').waitFor();
        await page
          .getByRole('combobox', { name: 'Access expires after' })
          .waitFor();
        if (state === 'approved') {
          await page
            .getByRole('button', { name: 'Approve', exact: true })
            .click();
          await page
            .getByRole('heading', { name: 'Machine approved' })
            .waitFor();
        }
      } else {
        await machineRow(page, visit.machines[0].id).waitFor();
        if (state === 'removed') {
          await machineRow(page, visit.machines[0].id)
            .getByRole('button', { name: /Remove/ })
            .click();
          await page
            .getByText('Removed codex-cloud-task-2b91', { exact: true })
            .waitFor();
          expect(await page.getByRole('alert').innerText()).toContain(
            `nook login ${visit.app.origin}`,
          );
        }
      }
      await page.evaluate(() => scrollTo(0, 0));
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      const filename = `machine-expiry-${state}-${size.name}-${theme}`;
      await page.screenshot({
        path: resolve(directory, `${filename}.png`),
        animations: 'disabled',
      });
      await page.screenshot({
        path: resolve(directory, `${filename}-full.png`),
        animations: 'disabled',
        fullPage: true,
      });
    } finally {
      await visit.close();
    }
  },
);
