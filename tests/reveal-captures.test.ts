import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { fetchValues } from './support/audit.ts';
import { auditEntries } from './support/audit-browser.ts';
import { issueGrant } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import {
  openReveal,
  revealPage,
  revealPath,
  revealSecret,
  valueField,
} from './support/reveal.ts';

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
  'short',
  'long',
  'revealing',
  'failed',
  'key-missing',
  'copied',
  'audit-row',
  'audit-details',
] as const;
const matrix = states.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'phone', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
const multilineValue = [
  '-----BEGIN SYNTHETIC KEY-----',
  ...Array.from({ length: 38 }, (_, i) => `synthetic-${i}-`.padEnd(70, 'x')),
  '-----END SYNTHETIC KEY-----',
].join('\n');
it.each(matrix)(
  'E27: capture $state $size.name $theme from real reveal requests and audit rows',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const errors: string[] = [];
    const visit = await revealPage(browser, {
      value: state === 'long' ? multilineValue : 'sk_test_123',
      viewport: size,
      colorScheme: theme,
      configure: async (page, app) => {
        page.on('pageerror', (error) => errors.push(error.name));
        if (state.startsWith('audit')) {
          expect(
            (
              await revealSecret(app, 'me/GITHUB_TOKEN', {
                'CF-Connecting-IP': '192.0.2.7',
              })
            ).status,
          ).toBe(200);
          const { token } = await issueGrant(app);
          expect(
            (
              await fetchValues(app, token, {
                secrets: [revealPath],
                purpose:
                  'Run billing integration tests against Stripe test mode',
                executable: 'pnpm',
              })
            ).status,
          ).toBe(200);
          await (await app.mf.getD1Database('DB'))
            .prepare(
              "UPDATE audit_entries SET at=CASE WHEN outcome='delivered' THEN '2026-10-09T11:13:00.000Z' ELSE '2026-10-08T10:00:00.000Z' END",
            )
            .run();
        }
        if (state === 'key-missing')
          await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
        if (state === 'failed')
          await (await app.mf.getD1Database('DB'))
            .prepare(
              "CREATE TRIGGER reveal_failure BEFORE INSERT ON audit_entries BEGIN SELECT RAISE(ABORT, 'synthetic audit failure'); END",
            )
            .run();
        if (state === 'revealing')
          await page.route('**/api/secrets/*/reveal', async (route) => {
            await gate.promise;
            await route.continue().catch(() => {});
          });
      },
    });
    try {
      const { page } = visit;
      const dialog = await openReveal(page);
      if (state === 'revealing')
        await dialog.getByText('Revealing…', { exact: true }).waitFor();
      else if (state === 'failed' || state === 'key-missing')
        await dialog
          .getByRole('button', { name: 'Try again', exact: true })
          .waitFor();
      else await valueField(page).waitFor();
      if (state === 'copied') {
        await dialog.getByRole('button', { name: 'Copy', exact: true }).click();
        await dialog
          .getByText('Copied to the clipboard.', { exact: true })
          .waitFor();
      }
      if (state === 'audit-row' || state === 'audit-details') {
        await (await visit.app.mf.getD1Database('DB'))
          .prepare(
            "UPDATE audit_entries SET at='2026-10-09T11:58:00.000Z' WHERE path=? AND outcome='revealed'",
          )
          .bind(revealPath)
          .run();
        await dialog.getByRole('link', { name: 'Audit', exact: true }).click();
        await page
          .getByRole('link', { name: 'Clear filters', exact: true })
          .first()
          .click();
        const row = auditEntries(page).first();
        await row
          .getByText('Revealed', { exact: true })
          .filter({ visible: true })
          .waitFor();
        if (state === 'audit-details') {
          await row.getByRole('button', { name: /Show details/ }).click();
          await row.getByText('Colombia', { exact: true }).waitFor();
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      if (!state.startsWith('audit')) {
        const box = await dialog.boundingBox();
        expect(
          box !== null &&
            box.x >= 0 &&
            box.y >= 0 &&
            box.x + box.width <= size.width &&
            box.y + box.height <= size.height,
        ).toBe(true);
      }
      expect(errors).toEqual([]);
      expect(
        await page.getByText('Prototype scenario', { exact: true }).count(),
      ).toBe(0);
      const png = await page.screenshot({
        path: resolve(directory, `reveal-${state}-${size.name}-${theme}.png`),
        animations: 'disabled',
      });
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        size.width,
        size.height,
      ]);
      if (state === 'audit-details' && size.name === 'phone')
        await page.screenshot({
          path: resolve(
            directory,
            `reveal-${state}-${size.name}-${theme}-full.png`,
          ),
          animations: 'disabled',
          fullPage: true,
        });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
