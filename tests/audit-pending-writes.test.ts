import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { auditNow } from './support/audit.ts';
import { auditEntries, visitAudit } from './support/audit-browser.ts';
import { jsonRequest } from './support/authorizations.ts';
import { deferred, listMachines } from './support/machines.ts';
import { confirmRevoke, machineRow } from './support/machines-browser.ts';
import { listSecrets } from './support/vault.ts';
import {
  createDraft,
  openSecretMenu,
  replaceDraft,
  secretRow,
} from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const secretPath = 'work/acme/STRIPE_KEY';
const createdPath = 'work/acme/RESEND_API_KEY';
const bucketPath = 'empty-candidate';
const cases = [
  { area: 'secrets', operation: 'create', start: '/vault?bucket=work/acme' },
  { area: 'secrets', operation: 'replace', start: '/vault?bucket=work/acme' },
  { area: 'secrets', operation: 'delete', start: '/vault?bucket=work/acme' },
  { area: 'buckets', operation: 'create', start: '/buckets' },
  { area: 'buckets', operation: 'delete', start: '/buckets' },
  { area: 'machines', operation: 'revoke', start: '/machines' },
] as const;
async function startSecretWrite(page: Page, operation: string) {
  if (operation === 'create') {
    const draft = await createDraft(page);
    await draft
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
  } else if (operation === 'replace') {
    await replaceDraft(page, secretPath);
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Replace value', exact: true })
      .click();
  } else {
    await openSecretMenu(page, secretPath, 'Delete secret…');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete secret', exact: true })
      .click();
  }
}
async function startBucketWrite(page: Page, operation: string) {
  if (operation === 'create') {
    const field = page.getByRole('textbox', { name: 'New bucket path' });
    await field.fill(bucketPath);
    await field.press('Enter');
  } else {
    await page
      .getByRole('button', { name: `Actions for ${bucketPath}`, exact: true })
      .click();
    await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete bucket', exact: true })
      .click();
  }
}
it.each(cases)(
  'Audit observes pending $area $operation without refreshing pre-commit metadata',
  async ({ area, operation, start }) => {
    const gate = deferred();
    let writes = 0;
    let settled = false;
    let failMetadata = false;
    let machineId = '';
    const reads: string[] = [];
    const visit = await visitAudit(browser, {
      count: 1,
      start,
      configure: async (page, app) => {
        if (area === 'buckets' && operation === 'delete')
          expect(
            (await jsonRequest(app, '/api/buckets', { path: bucketPath }))
              .status,
          ).toBe(200);
        [machineId] = (await listMachines(app)).map((machine) => machine.id);
        await page.clock.install({ time: auditNow });
        await page.route('**/api/**', async (route) => {
          const request = route.request();
          const path = new URL(request.url()).pathname;
          if (request.method() === 'GET' && path === `/api/${area}`) {
            reads.push(settled ? 'after-settlement' : 'before-settlement');
            if (failMetadata)
              return route.fulfill({
                status: 503,
                json: { _tag: 'ServiceUnavailable' },
              });
          }
          if (request.method() !== 'GET' && path.startsWith(`/api/${area}`)) {
            writes++;
            await gate.promise;
            const response = await route.fetch();
            if (area === 'secrets') {
              failMetadata = true;
              if (writes === 3) settled = true;
              return route.fulfill({
                status: 503,
                json: { _tag: 'ServiceUnavailable' },
              });
            }
            settled = true;
            return route.fulfill({ response });
          }
          return route.continue();
        });
      },
    });
    const { page } = visit;
    try {
      if (area === 'secrets') await secretRow(page, secretPath).waitFor();
      else if (area === 'machines') await machineRow(page, machineId).waitFor();
      else
        await page.getByRole('textbox', { name: 'New bucket path' }).waitFor();
      await page.waitForLoadState('networkidle');
      await page.clock.fastForward(31_001);
      if (area === 'secrets') await startSecretWrite(page, operation);
      else if (area === 'buckets') await startBucketWrite(page, operation);
      else await confirmRevoke(page, machineId);
      await expect.poll(() => writes).toBe(1);
      const before = reads.length;
      await page.getByRole('link', { name: 'Audit', exact: true }).hover();
      await page.getByRole('link', { name: 'Audit', exact: true }).click();
      await auditEntries(page).first().waitFor();
      await page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      await page.clock.runFor(100);
      expect(
        reads.length,
        'Audit intent, mounting, and focus defer metadata reads until the pending write settles',
      ).toBe(before);
      gate.resolve();
      await expect.poll(() => settled).toBe(true);
      if (area === 'secrets') {
        await expect.poll(() => writes).toBe(3);
        const current = await listSecrets(visit.app);
        expect(
          current.some(
            (secret) =>
              secret.path ===
              (operation === 'create' ? createdPath : secretPath),
          ),
        ).toBe(operation !== 'delete');
        await page
          .getByRole('link', { name: 'Vault', exact: true })
          .first()
          .click();
        await page
          .getByRole('list', { name: 'Buckets', exact: true })
          .locator('[data-path="work/acme"]')
          .getByRole('link')
          .click();
        const feedback = page
          .getByRole('alert')
          .filter({
            has: page.getByRole('button', { name: 'Dismiss', exact: true }),
          });
        await feedback.filter({ hasText: 'could not confirm' }).waitFor();
        if (operation !== 'delete')
          expect(
            await secretRow(
              page,
              operation === 'create' ? createdPath : secretPath,
            ).innerText(),
          ).toContain('Confirming');
        failMetadata = false;
        await feedback
          .getByRole('button', { name: 'Try again', exact: true })
          .click();
        await feedback
          .filter({
            hasText:
              operation === 'delete'
                ? 'Current secret state'
                : operation === 'create'
                  ? 'Secret saved'
                  : 'Value replaced',
          })
          .waitFor();
        expect(
          await secretRow(
            page,
            operation === 'create' ? createdPath : secretPath,
          ).count(),
        ).toBe(operation === 'delete' ? 0 : 1);
      }
    } finally {
      gate.resolve();
      try {
        await page.unrouteAll({ behavior: 'wait' });
      } finally {
        await visit.close();
      }
    }
  },
);
