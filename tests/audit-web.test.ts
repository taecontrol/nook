import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  acmePath,
  auditPageData,
  auditRows,
  fetchValues,
} from './support/audit.ts';
import {
  auditEntries,
  selectAudit,
  visitAudit,
} from './support/audit-browser.ts';
import { issueGrant } from './support/grants.ts';
import { deferred, listMachines, revokeMachine } from './support/machines.ts';
import { deleteSecret, expectNoValue, listSecrets } from './support/vault.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it('E17/E18/E28: chronological ledger, named facts, details and historical links use real audit entries', async () => {
  const visit = await visitAudit(browser);
  try {
    const { page } = visit;
    await page.getByRole('heading', { name: 'Audit', exact: true }).waitFor();
    const platform = page
      .locator('[data-sidebar="group"]')
      .filter({ hasText: 'Platform' });
    expect(await platform.getByRole('link').allTextContents()).toEqual([
      'Buckets',
      'Machines',
      'Audit',
    ]);
    await expect.poll(() => auditEntries(page).count()).toBe(25);
    expect(
      await auditEntries(page).evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-entry')),
      ),
    ).toEqual(visit.entries.map((entry) => entry.id));
    const first = auditEntries(page).first();
    expect(await first.innerText()).toContain('Just now');
    expect(await first.innerText()).toContain('GH_TOKEN');
    expect(await first.innerText()).toContain('work/acme');
    expect(await first.innerText()).toContain('Delivered');
    expect(await first.innerText()).toContain('open the release PR');
    expect(await first.innerText()).toContain('work-laptop');
    expect(await first.innerText()).toContain('gh');
    expect(await auditEntries(page).nth(1).innerText()).toContain('5m ago');
    expect(await auditEntries(page).nth(21).innerText()).toContain('3h ago');
    expect(
      await auditEntries(page).nth(22).locator('time').first().innerText(),
    ).toBe('Oct 7');
    await first.getByRole('button', { name: /Show details/ }).click();
    const text = await first.innerText();
    for (const fact of [
      acmePath,
      'Recorded',
      'GMT-3',
      'Working directory',
      '/synthetic/work/acme',
      'Executable',
      'Run',
      visit.entries[0].runId,
    ])
      expect(text).toContain(fact);
    await first.getByRole('link', { name: 'Uses of this secret' }).click();
    expect(new URL(page.url()).searchParams.get('secret')).toBe(acmePath);
    expectNoValue(await page.content(), visit.values);
  } finally {
    await visit.close();
  }
});
it('E17/E18: long phone content truncates in rows, wraps in details, and never overflows', async () => {
  const visit = await visitAudit(browser, {
    viewport: { width: 390, height: 844 },
    configure: async (_page, app, seeded) => {
      expect(
        (
          await fetchValues(app, seeded.token, {
            purpose: 'deployment '.repeat(18).trim(),
            workingDirectory: '/synthetic/' + 'very-long-directory/'.repeat(90),
            executable: 'long-command'.repeat(18),
            secrets: [
              'work/acme/billing-service/CLOUDFLARE_API_TOKEN_FOR_BILLING_SERVICE_PRODUCTION_DEPLOYS',
            ],
          })
        ).status,
      ).toBe(200);
    },
  });
  try {
    const { page } = visit;
    await auditEntries(page).first().waitFor();
    await auditEntries(page)
      .first()
      .getByRole('button', { name: /Show details/ })
      .click();
    expect(await auditEntries(page).first().innerText()).toContain(
      'Working directory',
    );
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
    await selectAudit(page, 'Bucket', 'work/acme/billing-service');
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await visit.close();
  }
});
it('E19: subtree/exact filters, URL reload and Back, cleared stale secret and historical URLs', async () => {
  const visit = await visitAudit(browser);
  const { page } = visit;
  try {
    await auditEntries(page).first().waitFor();
    await selectAudit(page, 'Bucket', 'work');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work');
    expect(
      (await auditEntries(page).allTextContents()).every(
        (text) => !text.includes('PLAID_SECRET'),
      ),
    ).toBe(true);
    await selectAudit(page, 'Secret', acmePath);
    await page.waitForLoadState('networkidle');
    await auditEntries(page).first().waitFor();
    const ids = await auditEntries(page).evaluateAll((rows) =>
      rows.map((row) => row.getAttribute('data-entry')),
    );
    await page.reload();
    await auditEntries(page).first().waitFor();
    expect(
      await auditEntries(page).evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-entry')),
      ),
    ).toEqual(ids);
    await selectAudit(page, 'Bucket', 'personal');
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).searchParams.has('secret')).toBe(false);
    await page.goBack();
    await auditEntries(page).first().waitFor();
    expect(new URL(page.url()).searchParams.get('secret')).toBe(acmePath);
    await page
      .getByRole('link', { name: 'Clear filters', exact: true })
      .first()
      .click();
    await page.waitForLoadState('networkidle');
    expect(new URL(page.url()).search).toBe('');
    const target = (await listSecrets(visit.app)).find(
      (secret) => secret.path === acmePath,
    )!;
    await deleteSecret(visit.app, target.path, target.version);
    await page.goto(visit.app.origin + '/audit?secret=work%2Facme%2FGH_TOKEN');
    await auditEntries(page).first().waitFor();
    expect(
      (await auditEntries(page).allTextContents()).every((text) =>
        text.includes('GH_TOKEN'),
      ),
    ).toBe(true);
  } finally {
    await visit.close();
  }
});
it('E20/E21: recorded denial reason, Deleted and Revoked use historical identity after deletion/revocation', async () => {
  const visit = await visitAudit(browser, {
    configure: async (_page, app) => {
      const denied = await issueGrant(app, ['work/acme']);
      expect(
        (
          await fetchValues(app, denied.token, {
            secrets: ['personal/finances/PLAID_SECRET'],
          })
        ).status,
      ).toBe(403);
      const [secret] = (await listSecrets(app)).filter(
        (secret) => secret.path === acmePath,
      );
      await deleteSecret(app, secret.path, secret.version);
      for (const machine of await listMachines(app))
        await revokeMachine(app, machine.id);
    },
  });
  try {
    const { page } = visit;
    await auditEntries(page).first().waitFor();
    const denied = auditEntries(page).filter({ hasText: 'Denied' }).first();
    await denied.getByRole('button', { name: /Show details/ }).click();
    expect(await denied.innerText()).toContain(
      'Outside this machine’s bucket grant. No value was delivered.',
    );
    expect(await denied.innerText()).toContain('Revoked');
    const delivered = auditEntries(page)
      .filter({ hasText: 'GH_TOKEN' })
      .first();
    await delivered.getByRole('button', { name: /Show details/ }).click();
    await expect.poll(() => delivered.innerText()).toContain('Deleted');
    expect(await delivered.innerText()).toContain('Revoked');
    expect(await delivered.innerText()).toContain('work-laptop');
    await delivered.getByRole('link', { name: 'Uses in this bucket' }).click();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
  } finally {
    await visit.close();
  }
});
it('E22: fresh and filtered-empty copy, clear filters and one skeleton status', async () => {
  const fresh = await visitAudit(browser, { count: 0 });
  try {
    await fresh.page.getByText('No secret uses yet', { exact: true }).waitFor();
    expect(await fresh.page.locator('body').innerText()).toContain('nook run');
    await selectAudit(fresh.page, 'Bucket', 'work');
    await fresh.page
      .getByText('No uses match these filters', { exact: true })
      .waitFor();
    await fresh.page
      .getByRole('link', { name: 'Clear filters' })
      .last()
      .click();
    await fresh.page.getByText('No secret uses yet', { exact: true }).waitFor();
  } finally {
    await fresh.close();
  }
  const gate = deferred();
  const loading = await visitAudit(browser, {
    configure: async (page) => {
      await page.route('**/api/audit**', async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    await loading.page
      .getByRole('status', { name: 'Loading audit entries' })
      .waitFor();
    expect(await loading.page.getByRole('status').count()).toBe(1);
    gate.resolve();
    await auditEntries(loading.page).first().waitFor();
  } finally {
    gate.resolve();
    await loading.close();
  }
});
it('E22: genuine D1 load failure retries, and older-page failure keeps loaded entries', async () => {
  const visit = await visitAudit(browser, {
    configure: async (_page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare(
          'ALTER TABLE audit_entries RENAME TO unavailable_audit_entries',
        )
        .run();
    },
  });
  try {
    const { page } = visit;
    await page
      .getByText('Couldn’t load audit entries', { exact: true })
      .waitFor();
    const db = await visit.app.mf.getD1Database('DB');
    await db
      .prepare('ALTER TABLE unavailable_audit_entries RENAME TO audit_entries')
      .run();
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await auditEntries(page).first().waitFor();
    const before = await auditEntries(page).count();
    await db
      .prepare('ALTER TABLE audit_entries RENAME TO unavailable_audit_entries')
      .run();
    await page
      .getByRole('button', { name: 'Load older entries', exact: true })
      .click();
    await page
      .getByText('Couldn’t load more entries', { exact: true })
      .waitFor();
    expect(await auditEntries(page).count()).toBe(before);
  } finally {
    await visit.close();
  }
});
it('E23: pagination appends 25 without duplicates or gaps while new uses arrive', async () => {
  const visit = await visitAudit(browser, { count: 56 });
  try {
    const { page } = visit;
    await expect.poll(() => auditEntries(page).count()).toBe(25);
    const original = (await auditRows(visit.app)).map((row) => String(row.id));
    expect((await fetchValues(visit.app, visit.token)).status).toBe(200);
    await page
      .getByRole('button', { name: 'Load older entries', exact: true })
      .click();
    await expect.poll(() => auditEntries(page).count()).toBe(50);
    await page
      .getByRole('button', { name: 'Load older entries', exact: true })
      .click();
    await expect.poll(() => auditEntries(page).count()).toBe(56);
    expect(
      await auditEntries(page).evaluateAll((rows) =>
        rows.map((row) => row.getAttribute('data-entry')),
      ),
    ).toEqual(original);
    await page
      .getByText('You’ve reached the first entry.', { exact: true })
      .waitFor();
  } finally {
    await visit.close();
  }
});
it('E24: Audit intent loads all four queries, filter pointer intent caches instantly then refreshes', async () => {
  const gate = deferred();
  let hold = false;
  const visit = await visitAudit(browser, {
    start: '/',
    configure: async (page) => {
      await page.route('**/api/audit**', async (route) => {
        if (hold) await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const { page } = visit;
    const link = page.getByRole('link', { name: 'Audit', exact: true });
    await link.hover();
    await page.waitForLoadState('networkidle');
    for (const path of [
      '/api/audit',
      '/api/buckets',
      '/api/secrets',
      '/api/machines',
    ])
      expect(visit.requests.some((request) => request.startsWith(path))).toBe(
        true,
      );
    await link.click();
    await auditEntries(page).first().waitFor();
    await page.getByRole('combobox', { name: 'Bucket', exact: true }).click();
    await page.getByRole('option', { name: 'work/acme', exact: true }).hover();
    await page.waitForLoadState('networkidle');
    expect(
      visit.requests.some((request) => request.includes('bucket=work%2Facme')),
    ).toBe(true);
    const beforeRefresh = visit.requests.filter((request) =>
      request.includes('bucket=work%2Facme'),
    ).length;
    hold = true;
    await page.getByRole('option', { name: 'work/acme', exact: true }).click();
    expect(
      await page.getByRole('status', { name: 'Loading audit entries' }).count(),
    ).toBe(0);
    expect(await auditEntries(page).count()).toBeGreaterThan(0);
    await expect
      .poll(
        () =>
          visit.requests.filter((request) =>
            request.includes('bucket=work%2Facme'),
          ).length,
      )
      .toBeGreaterThan(beforeRefresh);
    gate.resolve();
    await page.waitForLoadState('networkidle');
  } finally {
    gate.resolve();
    await visit.close();
  }
});
