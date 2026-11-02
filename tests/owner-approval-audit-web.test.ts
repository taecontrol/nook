import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { fetchValues } from './support/audit.ts';
import { auditEntries, selectAudit } from './support/audit-browser.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import {
  approvalFixture,
  ask,
  decide,
  pending,
  setMark,
  stripe,
  withdraw,
} from './support/owner-approval.ts';

let browser: Awaited<ReturnType<typeof launchTestBrowser>>;
beforeAll(async () => {
  browser = await launchTestBrowser();
});
afterAll(() => browser.close());
it('E30: Audit renders and filters approval events, owner IP/country and delivery approval id and duration', async () => {
  const app = await approvalFixture();
  const context = await browser.browser.newContext();
  const page = await context.newPage();
  try {
    await app.setBindings(app.bindings, { cf: { country: 'AR' } });
    await setMark(app);
    const id = randomUUID();
    const first = await pending(app, app.token, id);
    await decide(app, first.id, 'once');
    await ask(app, app.token, id);
    const denied = await pending(app, app.token);
    await decide(app, denied.id, 'deny');
    const cancelled = await pending(app, app.token);
    await withdraw(app, app.token, cancelled.id);
    await fetchValues(app, app.token, { secrets: [stripe] });
    await page.goto(`${app.origin}/audit`);
    await expect.poll(() => auditEntries(page).count()).toBe(8);
    for (const label of [
      'Approval requested',
      'Approval granted',
      'Approval denied',
      'Approval withdrawn',
      'Approval refused',
      'Delivered',
    ])
      expect(
        await page.getByText(label, { exact: true }).count(),
      ).toBeGreaterThan(0);
    for (const row of await auditEntries(page).all())
      await row.getByRole('button', { name: /Show details/ }).click();
    expect(await page.getByText('203.0.113.42', { exact: true }).count()).toBe(
      2,
    );
    expect(await page.getByText('Argentina', { exact: true }).count()).toBe(2);
    expect(
      await page.getByText(first.id, { exact: true }).count(),
    ).toBeGreaterThan(0);
    expect(
      await page.getByText('Only this time', { exact: true }).count(),
    ).toBeGreaterThan(0);
    await selectAudit(page, 'Secret', stripe);
    await expect.poll(() => auditEntries(page).count()).toBe(8);
    await selectAudit(page, 'Bucket', 'me');
    await expect.poll(() => auditEntries(page).count()).toBe(0);
  } finally {
    await closeBrowserPage(page, context);
    await app.close();
  }
});
