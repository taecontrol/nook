import { randomUUID } from 'node:crypto';
import type { Browser, Locator } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  filesPage,
  filesRows,
  openFiles,
} from './support/memory-files-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

function fact(row: Locator, label: string) {
  return row
    .locator('dl > div')
    .filter({ has: row.page().getByText(label, { exact: true }) })
    .locator('dd');
}

it('Files and Audit retain exact principal, client and byte-count text', async () => {
  const cases = [
    {
      name: 'machine.pdf',
      bytes: Buffer.alloc(2_418_734),
      principal: {
        kind: 'machine' as const,
        id: 'archived-machine',
        name: 'Archived laptop',
      },
      client: { name: 'agent', version: '1.2' },
      source: 'Archived laptop',
      short: '2.3 MiB',
      exact: '2,418,734 bytes',
      provenanceClient: 'agent 1.2',
      auditClient: 'agent 1.2',
    },
    {
      name: 'owner.pdf',
      bytes: Buffer.alloc(1024),
      principal: { kind: 'owner' as const },
      client: { name: 'versionless', version: null },
      source: 'Owner',
      short: '1 KiB',
      exact: '1,024 bytes',
      provenanceClient: 'versionless',
      auditClient: 'versionless',
    },
    {
      name: 'empty-file.pdf',
      bytes: Buffer.alloc(0),
      principal: { kind: 'owner' as const },
      client: { name: 'unknown', version: null },
      source: 'Owner',
      short: '0 B',
      exact: '0 bytes',
      provenanceClient: 'unknown',
      auditClient: 'unknown',
    },
  ];
  const visit = await filesPage(browser, { files: cases });
  try {
    const { page, app, files } = visit;
    await openFiles(page);
    for (const fixture of cases) {
      const row = filesRows(page).filter({
        has: page.getByText(fixture.name, { exact: true }),
      });
      expect(await row.locator('span.tabular-nums').textContent()).toBe(
        fixture.short,
      );
      expect(await row.textContent()).toContain(`by ${fixture.source}`);
      await row.getByRole('button', { name: 'Details', exact: true }).click();
      expect(await fact(row, 'Size').textContent()).toBe(fixture.exact);
      expect(await fact(row, 'Client (as reported)').textContent()).toBe(
        fixture.provenanceClient,
      );
    }
    const db = await app.mf.getD1Database('DB');
    const ids: string[] = [];
    for (const file of files) {
      const id = randomUUID();
      ids.push(id);
      await db
        .prepare(
          'INSERT INTO audit_entries(id,at,outcome,bucket,memory_id,file_name,file_size,file_sha256,machine_id,machine_name,client_name,client_version) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)',
        )
        .bind(
          id,
          '2026-10-22T14:00:00.000Z',
          'file_attached',
          'work/mamasan',
          file.memory_id,
          file.name,
          file.size,
          file.sha256,
          file.machine_id,
          file.machine_name,
          file.client_name,
          file.client_version,
        )
        .run();
    }
    await page.goto(`${app.origin}/audit`);
    for (const [index, fixture] of cases.entries()) {
      const row = page.locator(`[data-entry="${ids[index]}"]`);
      await row.waitFor();
      expect(await row.locator('p[title]').first().getAttribute('title')).toBe(
        fixture.exact,
      );
      await row.getByRole('button', { name: /Show details/ }).click();
      expect(await fact(row, 'Size').textContent()).toBe(fixture.exact);
      expect(
        await fact(row, 'Size').evaluate((element) =>
          Array.from(element.childNodes, (node) => ({
            type: node.nodeType,
            text: node.textContent,
          })),
        ),
      ).toEqual([
        { type: 3, text: fixture.exact.slice(0, -6) },
        { type: 3, text: ' bytes' },
      ]);
      expect(await fact(row, 'Client (as reported)').textContent()).toBe(
        fixture.auditClient,
      );
      expect(await fact(row, 'Source').textContent()).toBe(
        fixture.source + (index === 0 ? 'Revoked' : ''),
      );
      expect(await row.locator('p[title]').last().textContent()).toBe(
        fixture.auditClient,
      );
    }
  } finally {
    await visit.close();
  }
});
