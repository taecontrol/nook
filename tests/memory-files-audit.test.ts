import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { auditRows } from './support/audit.ts';
import { auditEntries } from './support/audit-browser.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { memoryFixture, memoryId, seedMemories } from './support/memory.ts';
import { attachFile, fileBucket, fileMachine } from './support/memory-files.ts';
import {
  fileAuditLifecycle,
  fileAuditPage,
  moreFileAudit,
} from './support/memory-files-audit.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';

let app: FilesRuntime;
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());
beforeEach(async () => {
  app = await filesRuntime();
});
afterEach(() => app?.close());
it('E27: Audit lists all five file outcomes, filters bucket descendants, paginates mixed rows and retains Vault facts', async () => {
  const { before, machine } = await fileAuditLifecycle(app);
  await moreFileAudit(app, machine.token);
  await seedMemories(app, [
    memoryFixture(608, { bucket: `${fileBucket}/api` }),
    memoryFixture(609, { bucket: 'work/mamasan-old' }),
  ]);
  const all = await fileMachine(app, ['work']);
  await attachFile(app, all.token, {
    id: memoryId(608),
    name: 'descendant.pdf',
  });
  await attachFile(app, all.token, {
    id: memoryId(609),
    name: 'prefix-sibling.pdf',
  });
  const stored = await auditRows(app);
  const first = await fileAuditPage(app);
  expect(first.entries).toHaveLength(25);
  expect(first.next).toEqual(expect.any(String));
  const entries = [...first.entries];
  let next = first.next;
  while (next) {
    const page = await fileAuditPage(
      app,
      `?cursor=${encodeURIComponent(next)}`,
    );
    entries.push(...page.entries);
    next = page.next;
  }
  expect(entries.map((entry) => entry.id)).toEqual(
    stored.map((entry) => entry.id),
  );
  expect(new Set(entries.map((entry) => entry.id)).size).toBe(stored.length);
  const fileOutcomes = entries
    .map((entry) => entry.outcome)
    .filter((value) => String(value).startsWith('file_'));
  expect([...new Set(fileOutcomes)].sort()).toEqual([
    'file_attached',
    'file_detached',
    'file_downloaded',
    'file_forgotten',
    'file_replaced',
  ]);
  for (const previous of before) {
    const current = stored.find((entry) => entry.id === previous.id);
    expect(current).toEqual(previous);
    const publicEntry = entries.find((entry) => entry.id === previous.id);
    expect(publicEntry).toMatchObject({
      bucket: fileBucket,
      path: previous.path,
      purpose: previous.purpose,
      outcome: previous.outcome,
    });
  }
  const filtered: Record<string, unknown>[] = [];
  next = null;
  do {
    const page = await fileAuditPage(
      app,
      `?bucket=${encodeURIComponent(fileBucket)}${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
    );
    filtered.push(...page.entries);
    next = page.next;
  } while (next);
  expect(filtered.map((entry) => entry.id)).toEqual(
    stored
      .filter(
        (row) =>
          row.bucket === fileBucket || row.bucket === `${fileBucket}/api`,
      )
      .map((row) => row.id),
  );
  expect(filtered.some((row) => row.bucket === `${fileBucket}/api`)).toBe(true);
  expect(filtered.some((row) => row.bucket === 'work/mamasan-old')).toBe(false);
});
async function expectActivityLabels(
  page: Page,
  labels: { region: string; item: string; summary: string; source: string },
) {
  const region = page.getByRole('region', { name: labels.region, exact: true });
  expect(await region.count()).toBe(1);
  for (const label of [labels.item, labels.summary, labels.source])
    expect(await region.getByText(label, { exact: true }).isVisible()).toBe(
      true,
    );
}
it('E27: Chromium renders the five file outcomes with expandable facts, file and mixed labels, and mixed pagination', async () => {
  const { machine } = await fileAuditLifecycle(app);
  await moreFileAudit(app, machine.token);
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(`${app.origin}/audit`);
    await expect.poll(() => auditEntries(page).count()).toBe(25);
    // The newest page holds only attachments; older pages add Vault rows.
    await expectActivityLabels(page, {
      region: 'File activity',
      item: 'File / bucket',
      summary: 'Size',
      source: 'Source / client',
    });
    await page
      .getByRole('button', { name: 'Load older entries', exact: true })
      .click();
    const rows = await auditRows(app);
    await expect.poll(() => auditEntries(page).count()).toBe(rows.length);
    await expectActivityLabels(page, {
      region: 'Secret and file activity',
      item: 'Secret or file / bucket',
      summary: 'Purpose or size',
      source: 'Source',
    });
    for (const outcome of [
      'file_attached',
      'file_replaced',
      'file_downloaded',
      'file_detached',
      'file_forgotten',
    ]) {
      const entry = rows.find((row) => row.outcome === outcome);
      if (!entry)
        throw new Error(`The file lifecycle did not produce ${outcome}.`);
      const row = page.locator(`[data-entry="${entry.id}"]`);
      expect(await row.innerText()).toContain(String(entry.file_name));
      expect(await row.locator('time').count()).toBeGreaterThan(0);
      await row.getByRole('button', { name: /Show details/ }).click();
      expect(await row.innerText()).toContain(String(entry.file_sha256));
      const owner = outcome === 'file_detached' || outcome === 'file_forgotten';
      expect(entry.machine_name).toBe(owner ? null : machine.name);
      expect(await row.innerText()).toContain(owner ? 'Owner' : machine.name);
    }
  } finally {
    await closeBrowserPage(page, context);
  }
});
