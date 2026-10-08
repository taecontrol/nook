import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { createdPath, machineCreate } from './support/agent-create.ts';
import { auditNow, fetchValues } from './support/audit.ts';
import {
  auditEntries,
  selectAudit,
  visitAudit,
} from './support/audit-browser.ts';
import { issueGrant } from './support/grants.ts';

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
  'E22: creations share the chronological ledger and filters, without executable/run details ($width)',
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
        const db = await app.mf.getD1Database('DB');
        await db
          .prepare("UPDATE audit_entries SET at=? WHERE outcome='created'")
          .bind(new Date(auditNow.getTime() - 1000).toISOString())
          .run();
        await db
          .prepare("UPDATE audit_entries SET at=? WHERE outcome='denied'")
          .bind(new Date(auditNow.getTime() - 2000).toISOString())
          .run();
      },
    });
    try {
      const { page } = visit;
      await expect.poll(() => auditEntries(page).count()).toBe(3);
      const texts = await auditEntries(page).allTextContents();
      expect(texts[0]).toContain('Delivered');
      expect(texts[1]).toContain('Created');
      expect(texts[2]).toContain('Denied');
      const row = auditEntries(page).nth(1);
      await row.getByRole('button', { name: /Show details/ }).click();
      const details = await row.innerText();
      for (const fact of [
        'Secret',
        'Recorded',
        'Machine',
        'Purpose',
        'Working directory',
        createdPath,
        '/synthetic/work/acme',
      ])
        expect(details).toContain(fact);
      expect(/Executable|\bRun\b|undefined/.test(details)).toBe(false);
      await row.getByRole('link', { name: 'Activity for this secret' }).click();
      await expect.poll(() => auditEntries(page).count()).toBe(1);
      expect(await auditEntries(page).first().innerText()).toContain('Created');
      await selectAudit(page, 'Secret', 'All secrets');
      await selectAudit(page, 'Bucket', 'work/acme');
      await expect.poll(() => auditEntries(page).count()).toBe(2);
      expect(
        (await auditEntries(page).allTextContents()).some((text) =>
          text.includes('Created'),
        ),
      ).toBe(true);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
    } finally {
      await visit.close();
    }
  },
);
it('E23: fresh Audit explains uses and creations without adding a kind control', async () => {
  const visit = await visitAudit(browser, { count: 0 });
  try {
    const { page } = visit;
    await page
      .getByText('No secret uses or creations yet', { exact: true })
      .waitFor();
    expect(await page.locator('h1 + p').innerText()).toContain(
      'Every secret use and creation, newest first.',
    );
    expect(
      await page.locator('[data-slot="empty-description"]').innerText(),
    ).toContain('nook vault create');
    expect(await page.getByRole('combobox').count()).toBe(2);
  } finally {
    await visit.close();
  }
});
