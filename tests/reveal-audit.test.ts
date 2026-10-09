import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { machineCreate } from './support/agent-create.ts';
import { auditNow, auditRows, fetchValues } from './support/audit.ts';
import {
  auditEntries,
  selectAudit,
  visitAudit,
} from './support/audit-browser.ts';
import { issueGrant } from './support/grants.ts';
import {
  revealCountry,
  revealIp,
  revealPath,
  revealSecret,
} from './support/reveal.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it.each([
  { width: 390, height: 844 },
  { width: 1440, height: 900 },
])(
  'E24/E26: revealed rows share chronological order and filters with previous created/delivered/denied entries ($width)',
  async (viewport) => {
    const visit = await visitAudit(browser, {
      count: 1,
      viewport,
      configure: async (_page, app, seeded) => {
        expect((await machineCreate(app, seeded.token)).status).toBe(201);
        const limited = await issueGrant(app, ['work/acme']);
        expect(
          (
            await fetchValues(app, limited.token, {
              secrets: ['personal/finances/PLAID_SECRET'],
            })
          ).status,
        ).toBe(403);
        await app.setBindings(app.bindings, { cf: { country: revealCountry } });
        expect(
          (
            await revealSecret(app, revealPath, {
              'CF-Connecting-IP': revealIp,
            })
          ).status,
        ).toBe(200);
        const db = await app.mf.getD1Database('DB');
        for (const [index, outcome] of [
          'revealed',
          'created',
          'denied',
          'delivered',
        ].entries())
          await db
            .prepare('UPDATE audit_entries SET at=? WHERE outcome=?')
            .bind(
              new Date(auditNow.getTime() - index * 1000).toISOString(),
              outcome,
            )
            .run();
      },
    });
    try {
      const { page } = visit;
      await expect.poll(() => auditEntries(page).count()).toBe(4);
      const texts = await auditEntries(page).allTextContents();
      for (const [index, outcome] of [
        'Revealed',
        'Created',
        'Denied',
        'Delivered',
      ].entries())
        expect(texts[index]).toContain(outcome);
      const row = auditEntries(page).first();
      expect(await row.innerText()).toContain('Web app');
      expect(await row.innerText()).toContain(`${revealIp} · CO`);
      expect(await row.locator('.lucide-eye').count()).toBeGreaterThan(0);
      await row.getByRole('button', { name: /Show details/ }).click();
      for (const [label, value] of Object.entries({
        Secret: revealPath,
        Source: 'Web app',
        Purpose: 'Revealed in web app',
        'IP address': revealIp,
        Country: 'Colombia',
      }))
        expect(
          await row
            .getByText(label, { exact: true })
            .locator('..')
            .locator('dd')
            .innerText(),
        ).toContain(value);
      expect(
        await row
          .getByText('Recorded', { exact: true })
          .locator('..')
          .locator('time')
          .getAttribute('datetime'),
      ).toBe(auditNow.toISOString());
      expect(await row.locator('dt').allTextContents()).toEqual([
        'Secret',
        'Recorded',
        'Source',
        'Purpose',
        'IP address',
        'Country',
      ]);
      expect(await row.getByText('Revoked', { exact: true }).count()).toBe(0);
      await row
        .getByRole('link', { name: 'Activity for this secret', exact: true })
        .click();
      await expect.poll(() => auditEntries(page).count()).toBe(1);
      expect(await auditEntries(page).first().innerText()).toContain(
        'Revealed',
      );
      await selectAudit(page, 'Secret', 'All secrets');
      await selectAudit(page, 'Bucket', 'work/acme');
      await expect.poll(() => auditEntries(page).count()).toBe(3);
      expect(
        (await auditEntries(page).allTextContents()).some((text) =>
          text.includes('Revealed'),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
      expect(await auditRows(visit.app)).toHaveLength(4);
    } finally {
      await visit.close();
    }
  },
);
it.each([
  {
    country: 'XQ',
    ip: '192.0.2.8',
    expectedCountry: 'XQ',
    expectedIp: '192.0.2.8',
  },
  {
    country: 'invalid-code',
    ip: '192.0.2.9',
    expectedCountry: 'invalid-code',
    expectedIp: '192.0.2.9',
  },
  {
    country: null,
    ip: null,
    expectedCountry: 'Unknown',
    expectedIp: 'Unknown',
  },
])(
  'E24: missing request facts show Unknown and unrecognized countries fall back to their raw code ($country)',
  async ({ country, ip, expectedCountry, expectedIp }) => {
    const absentFacts =
      country === null
        ? await vaultCheckpoints(async () => true, undefined, false, {
            omitIp: true,
          })
        : undefined;
    const visit = await visitAudit(browser, {
      app: absentFacts,
      count: 0,
      configure: async (_page, app) => {
        await app.setBindings(app.bindings, {
          cf: country === null ? {} : { country },
        });
        expect(
          (
            await revealSecret(app, revealPath, {
              'CF-Connecting-IP': ip ?? '',
            })
          ).status,
        ).toBe(200);
      },
    });
    try {
      const row = auditEntries(visit.page).first();
      await row.getByRole('button', { name: /Show details/ }).click();
      expect(
        await row
          .getByText('IP address', { exact: true })
          .locator('..')
          .locator('dd')
          .innerText(),
      ).toBe(expectedIp);
      expect(
        await row
          .getByText('Country', { exact: true })
          .locator('..')
          .locator('dd')
          .innerText(),
      ).toBe(expectedCountry);
    } finally {
      await visit.close();
    }
  },
);
it('E25: fresh Audit mentions uses, creations and reveals in its subtitle and empty state', async () => {
  const visit = await visitAudit(browser, { count: 0 });
  try {
    await visit.page
      .getByText('No secret activity yet', { exact: true })
      .waitFor();
    expect(await visit.page.locator('h1 + p').innerText()).toContain(
      'Every secret use, creation, and reveal, newest first.',
    );
    expect(
      await visit.page.locator('[data-slot="empty-description"]').innerText(),
    ).toMatch(/reveal/i);
    expect(await visit.page.getByRole('combobox').count()).toBe(2);
  } finally {
    await visit.close();
  }
});
