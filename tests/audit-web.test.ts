import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  acmePath,
  auditNow,
  auditPageData,
  auditRows,
  fetchValues,
} from './support/audit.ts';
import {
  auditEntries,
  selectAudit,
  visitAudit,
} from './support/audit-browser.ts';
import { jsonRequest } from './support/authorizations.ts';
import { issueGrant } from './support/grants.ts';
import { deferred, listMachines, revokeMachine } from './support/machines.ts';
import {
  createSecret,
  deleteSecret,
  expectNoValue,
  listSecrets,
  secretInput,
} from './support/vault.ts';

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
    expect(
      await denied
        .locator('[data-slot="badge"]')
        .first()
        .getAttribute('data-variant'),
    ).toBe('destructive');
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
    expect(await fresh.page.locator('body').innerText()).toContain(
      'Denied requests appear here too.',
    );
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
    expect(
      visit.requests.filter((request) => request.startsWith('/api/audit'))
        .length,
    ).toBe(1);
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

it('E19: the valid all bucket is distinct from All buckets in selection and intent', async () => {
  const visit = await visitAudit(browser, {
    count: 1,
    configure: async (_page, app, seeded) => {
      expect(
        (await jsonRequest(app, '/api/buckets', { path: 'all/child' })).status,
      ).toBe(200);
      for (const bucket of ['all', 'all/child']) {
        expect(
          (await createSecret(app, secretInput({ bucket, name: 'ALL_KEY' })))
            .status,
        ).toBe(201);
        const response = await fetchValues(app, seeded.token, {
          secrets: [`${bucket}/ALL_KEY`],
        });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      }
    },
  });
  try {
    const { page } = visit;
    await expect.poll(() => auditEntries(page).count()).toBe(3);
    await page.getByRole('combobox', { name: 'Bucket', exact: true }).click();
    await page.getByRole('option', { name: 'all', exact: true }).hover();
    await expect
      .poll(() =>
        visit.requests.some((request) => request.includes('bucket=all')),
      )
      .toBe(true);
    await page.getByRole('option', { name: 'all', exact: true }).click();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('all');
    await expect.poll(() => auditEntries(page).count()).toBe(2);
    expect(
      (await auditEntries(page).allTextContents()).every((entry) =>
        entry.includes('ALL_KEY'),
      ),
    ).toBe(true);
    await page.reload();
    await expect.poll(() => auditEntries(page).count()).toBe(2);
    const unfiltered = () =>
      visit.requests.filter((request) => request === '/api/audit').length;
    const beforeClear = unfiltered();
    await page.getByRole('combobox', { name: 'Bucket', exact: true }).click();
    await page
      .getByRole('option', { name: 'All buckets', exact: true })
      .hover();
    await expect.poll(unfiltered).toBeGreaterThan(beforeClear);
    await page
      .getByRole('option', { name: 'All buckets', exact: true })
      .click();
    expect(new URL(page.url()).searchParams.has('bucket')).toBe(false);
    await expect.poll(() => auditEntries(page).count()).toBe(3);
  } finally {
    await visit.close();
  }
});

it('E19: bucket controls reject prefix-lookalike secret choices and clear their selection', async () => {
  const path = 'work/acme-old/GH_TOKEN';
  const visit = await visitAudit(browser, {
    count: 1,
    configure: async (_page, app, seeded) => {
      expect(
        (await jsonRequest(app, '/api/buckets', { path: 'work/acme-old' }))
          .status,
      ).toBe(200);
      expect(
        (
          await createSecret(
            app,
            secretInput({ bucket: 'work/acme-old', name: 'GH_TOKEN' }),
          )
        ).status,
      ).toBe(201);
      const response = await fetchValues(app, seeded.token, {
        secrets: [path],
      });
      expect(response.status).toBe(200);
      await response.body?.cancel();
    },
  });
  try {
    const { page } = visit;
    await auditEntries(page).first().waitFor();
    await selectAudit(page, 'Secret', path);
    await selectAudit(page, 'Bucket', 'work/acme');
    expect(new URL(page.url()).searchParams.has('secret')).toBe(false);
    await page.getByRole('combobox', { name: 'Secret', exact: true }).click();
    expect(
      await page.getByRole('option', { name: path, exact: true }).count(),
    ).toBe(0);
    expect(
      await page.getByRole('option', { name: acmePath, exact: true }).count(),
    ).toBe(1);
    expect(
      await page
        .getByRole('option', { name: 'work/acme/STRIPE_KEY', exact: true })
        .count(),
    ).toBe(1);
  } finally {
    await visit.close();
  }
});
it('E19: historical URL selections remain visible even when no matching entry is loaded', async () => {
  const visit = await visitAudit(browser, {
    count: 1,
    start: '/audit?bucket=work%2Fdeleted&secret=work%2Fdeleted%2FMISSING',
  });
  try {
    const { page } = visit;
    await page
      .getByText('No uses match these filters', { exact: true })
      .waitFor();
    expect(
      await page
        .getByRole('combobox', { name: 'Bucket', exact: true })
        .innerText(),
    ).toBe('work/deleted');
    expect(
      await page
        .getByRole('combobox', { name: 'Secret', exact: true })
        .innerText(),
    ).toBe('work/deleted/MISSING');
  } finally {
    await visit.close();
  }
});
it('E19: a deleted secret in loaded history remains a filter choice', async () => {
  const visit = await visitAudit(browser, {
    count: 1,
    configure: async (_page, app) => {
      const secret = (await listSecrets(app)).find(
        (entry) => entry.path === acmePath,
      )!;
      expect((await deleteSecret(app, acmePath, secret.version)).status).toBe(
        204,
      );
    },
  });
  try {
    const { page } = visit;
    await auditEntries(page).first().waitFor();
    await page.waitForLoadState('networkidle');
    await selectAudit(page, 'Secret', acmePath);
    expect(new URL(page.url()).searchParams.get('secret')).toBe(acmePath);
    await expect.poll(() => auditEntries(page).count()).toBe(1);
  } finally {
    await visit.close();
  }
});
it('E17: date labels retain the year and advance after a minute on an idle page', async () => {
  const visit = await visitAudit(browser, {
    count: 2,
    configure: async (page, app, seeded) => {
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare('UPDATE audit_entries SET at=? WHERE id=?')
        .bind('2025-10-07T12:00:00.000Z', seeded.entries[1].id)
        .run();
      await page.clock.install({ time: auditNow });
    },
  });
  try {
    const { page } = visit;
    await expect.poll(() => auditEntries(page).count()).toBe(2);
    expect(
      await auditEntries(page).last().locator('time').first().innerText(),
    ).toBe('Oct 7, 2025');
    expect(await auditEntries(page).first().innerText()).toContain('Just now');
    await page.clock.runFor(60_000);
    expect(await auditEntries(page).first().innerText()).toContain('1m ago');
  } finally {
    await visit.close();
  }
});

it('E24: intent on historical detail links preloads their URL filters before navigation', async () => {
  const visit = await visitAudit(browser, { count: 2 });
  try {
    const { page } = visit;
    const row = auditEntries(page).first();
    await row.waitFor();
    await row.getByRole('button', { name: /Show details/ }).click();
    const secret = row.getByRole('link', { name: 'Uses of this secret' });
    await secret.hover();
    await expect
      .poll(() =>
        visit.requests.some((request) =>
          request.includes('secret=work%2Facme%2FGH_TOKEN'),
        ),
      )
      .toBe(true);
    const bucket = row.getByRole('link', { name: 'Uses in this bucket' });
    await bucket.hover();
    await expect
      .poll(() =>
        visit.requests.some((request) =>
          request.includes('bucket=work%2Facme'),
        ),
      )
      .toBe(true);
    await bucket.click();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
    expect(
      await page.getByRole('status', { name: 'Loading audit entries' }).count(),
    ).toBe(0);
    expect(await auditEntries(page).count()).toBe(2);
  } finally {
    await visit.close();
  }
});

it.each(['123', '1e3', 'true', 'false', 'null'].map((bucket) => ({ bucket })))(
  'E19: a JSON-like bucket $bucket works from an ordinary direct URL and after reload',
  async ({ bucket }) => {
    const visit = await visitAudit(browser, {
      count: 1,
      start: `/audit?bucket=${bucket}`,
      configure: async (_page, app, seeded) => {
        expect(
          (await jsonRequest(app, '/api/buckets', { path: bucket })).status,
        ).toBe(200);
        expect(
          (await createSecret(app, secretInput({ bucket, name: 'URL_KEY' })))
            .status,
        ).toBe(201);
        const response = await fetchValues(app, seeded.token, {
          secrets: [`${bucket}/URL_KEY`],
        });
        expect(response.status).toBe(200);
        await response.body?.cancel();
      },
    });
    try {
      const { page } = visit;
      await expect.poll(() => auditEntries(page).count()).toBe(1);
      expect(await auditEntries(page).first().innerText()).toContain('URL_KEY');
      expect(
        await page
          .getByRole('combobox', { name: 'Bucket', exact: true })
          .innerText(),
      ).toBe(bucket);
      await selectAudit(page, 'Bucket', 'All buckets');
      await expect.poll(() => auditEntries(page).count()).toBe(2);
      await selectAudit(page, 'Bucket', bucket);
      expect(new URL(page.url()).searchParams.get('bucket')).toBe(bucket);
      await page.reload();
      await expect.poll(() => auditEntries(page).count()).toBe(1);
      expect(await auditEntries(page).first().innerText()).toContain('URL_KEY');
      await page.goto(`${visit.app.origin}/vault?bucket=${bucket}`);
      await page.locator(`[data-secret="${bucket}/URL_KEY"]`).waitFor();
      expect(
        await page.locator(`[data-secret="${bucket}/URL_KEY"]`).count(),
      ).toBe(1);
    } finally {
      await visit.close();
    }
  },
);

it('E21: unknown current metadata does not claim a historical secret is deleted or a machine revoked', async () => {
  const gate = deferred();
  const visit = await visitAudit(browser, {
    count: 1,
    configure: async (page) => {
      for (const area of ['secrets', 'machines'])
        await page.route(`**/api/${area}`, async (route) => {
          await gate.promise;
          await route.continue().catch(() => {});
        });
    },
  });
  try {
    const row = auditEntries(visit.page).first();
    await row.waitFor();
    await row.getByRole('button', { name: /Show details/ }).click();
    const text = await row.innerText();
    expect(text.includes('Deleted') || text.includes('Revoked')).toBe(false);
    gate.resolve();
    await visit.page.waitForLoadState('networkidle');
    expect((await row.innerText()).includes('Deleted')).toBe(false);
    expect((await row.innerText()).includes('Revoked')).toBe(false);
  } finally {
    gate.resolve();
    await visit.page.unrouteAll({ behavior: 'wait' });
    await visit.close();
  }
});
