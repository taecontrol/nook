import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { acmePath, auditNow, fetchValues } from './support/audit.ts';
import { auditEntries, visitAudit } from './support/audit-browser.ts';
import { issueGrant } from './support/grants.ts';
import { deferred, listMachines, revokeMachine } from './support/machines.ts';
import { deleteSecret, listSecrets } from './support/vault.ts';

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
  'fresh',
  'denied-recent',
  'filter-secret',
  'filter-bucket',
  'filter-empty',
  'long-content',
  'many',
  'deleted-revoked',
  'loading',
  'load-error',
  'created',
] as const;
const matrix = states.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'phone', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);
it.each(matrix)(
  'E26: capture $state $size.name $theme from real Worker data',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const errors: string[] = [];
    const start =
      state === 'filter-secret'
        ? '/audit?secret=work%2Facme%2FGH_TOKEN'
        : state === 'filter-bucket'
          ? '/audit?bucket=work'
          : state === 'filter-empty'
            ? '/audit?secret=work%2Facme%2FUNUSED'
            : '/audit';
    const visit = await visitAudit(browser, {
      count: state === 'fresh' ? 0 : state === 'many' ? 76 : 30,
      start,
      viewport: size,
      colorScheme: theme,
      configure: async (page, app, seeded) => {
        page.on('pageerror', (error) => errors.push(error.name));
        const db = await app.mf.getD1Database('DB');
        if (state === 'created') {
          expect(
            (
              await machineCreate(
                app,
                seeded.token,
                machineCreateInput({
                  bucket: 'work/acme/billing-service',
                  name: 'NEW_PROVIDER_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
                  purpose:
                    'token from provider setup for the billing-service production deploy pipeline '
                      .repeat(2)
                      .trim(),
                  workingDirectory:
                    '/synthetic/projects/' +
                    'billing-service-production/'.repeat(45),
                }),
              )
            ).status,
          ).toBe(201);
          const { token } = await issueGrant(app, ['work/acme']);
          expect(
            (
              await fetchValues(app, token, {
                secrets: ['personal/finances/PLAID_SECRET'],
              })
            ).status,
          ).toBe(403);
          await db
            .prepare("UPDATE audit_entries SET at=? WHERE outcome='created'")
            .bind(new Date(auditNow.getTime() - 1000).toISOString())
            .run();
          await db
            .prepare("UPDATE audit_entries SET at=? WHERE outcome='denied'")
            .bind(new Date(auditNow.getTime() - 2000).toISOString())
            .run();
        }
        if (state === 'denied-recent') {
          const { token } = await issueGrant(app, ['work/acme']);
          expect(
            (
              await fetchValues(app, token, {
                secrets: ['personal/finances/PLAID_SECRET'],
              })
            ).status,
          ).toBe(403);
        }
        if (state === 'long-content') {
          await db
            .prepare('UPDATE machine_tokens SET machine_name=?')
            .bind(
              'luis-macbook-pro-16-inch-2026-client-site-loaner-for-billing',
            )
            .run();
          expect(
            (
              await fetchValues(app, seeded.token, {
                purpose:
                  'deploy billing-service to production after the migration review '
                    .repeat(3)
                    .trim(),
                workingDirectory:
                  '/synthetic/projects/' +
                  'billing-service-production/'.repeat(45),
                executable: 'wrangler',
                secrets: [
                  'work/acme/billing-service/CLOUDFLARE_API_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
                ],
              })
            ).status,
          ).toBe(200);
          await db
            .prepare(
              "UPDATE audit_entries SET at=? WHERE path LIKE 'work/acme/billing-service/%'",
            )
            .bind(new Date(auditNow.getTime() - 360_000).toISOString())
            .run();
        }
        if (state === 'deleted-revoked') {
          const secret = (await listSecrets(app)).find(
            (item) => item.path === acmePath,
          )!;
          await deleteSecret(app, acmePath, secret.version);
          for (const machine of await listMachines(app))
            await revokeMachine(app, machine.id);
        }
        if (state === 'load-error')
          await db
            .prepare(
              'ALTER TABLE audit_entries RENAME TO unavailable_audit_entries',
            )
            .run();
        if (state === 'loading')
          await page.route('**/api/audit**', async (route) => {
            await gate.promise;
            await route.continue().catch(() => {});
          });
      },
    });
    try {
      const { page } = visit;
      await page.getByRole('heading', { name: 'Audit', exact: true }).waitFor();
      if (state === 'loading')
        await page
          .getByRole('status', { name: 'Loading audit entries' })
          .waitFor();
      else if (state === 'load-error')
        await page
          .getByText('Couldn’t load audit entries', { exact: true })
          .waitFor();
      else if (state === 'fresh')
        await page
          .getByText('No secret activity yet', { exact: true })
          .waitFor();
      else if (state === 'filter-empty')
        await page
          .getByText('No activity matches these filters', { exact: true })
          .waitFor();
      else {
        await auditEntries(page).first().waitFor();
        if (state === 'long-content' || state === 'deleted-revoked') {
          await (state === 'long-content'
            ? auditEntries(page)
                .filter({
                  hasText:
                    'CLOUDFLARE_API_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
                })
                .first()
            : auditEntries(page).first()
          )
            .getByRole('button', { name: /Show details/ })
            .click();
          await page.getByText('Working directory', { exact: true }).waitFor();
        }
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(errors).toEqual([]);
      expect(
        await page
          .getByRole('button', { name: /Scenarios|Reset scenario/i })
          .count(),
      ).toBe(0);
      const png = await page.screenshot({
        path: resolve(directory, `audit-${state}-${size.name}-${theme}.png`),
        animations: 'disabled',
      });
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        size.width,
        size.height,
      ]);
      if (state === 'created') {
        const row = auditEntries(page)
          .filter({
            hasText:
              'NEW_PROVIDER_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
          })
          .first();
        expect(await row.innerText()).toContain('Created');
        await row.getByRole('button', { name: /Show details/ }).click();
        await page.getByText('Working directory', { exact: true }).waitFor();
        expect(
          await page.evaluate(() => document.documentElement.scrollWidth),
        ).toBe(size.width);
        expect(/Executable|\bRun\b/.test(await row.innerText())).toBe(false);
        await page.screenshot({
          path: resolve(
            directory,
            `audit-created-details-${size.name}-${theme}.png`,
          ),
          animations: 'disabled',
          fullPage: true,
        });
      }
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
