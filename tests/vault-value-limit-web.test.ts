import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { createDraft } from './support/vault-browser.ts';
import {
  createImport,
  importPage,
  importSettled,
  importSheet,
  reviewPaste,
  reviewRow,
} from './support/vault-import-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('the value limit keeps its exact create, validation, review and skipped-result text', async () => {
  const visit = await importPage(browser);
  const { page, traffic } = visit;
  const oversized = `${'🔐'.repeat(16 * 1024)}x`;
  try {
    const sheet = await createDraft(page);
    expect(await sheet.locator('#secret-value-feedback').textContent()).toBe(
      'Up to 64 KiB, several lines are fine. Once saved, it is encrypted; reveal it from the list when you need it.',
    );
    await sheet
      .getByRole('textbox', { name: 'Value', exact: true })
      .fill(oversized);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    expect(await sheet.locator('#secret-value-feedback').textContent()).toBe(
      'A value can be at most 64 KiB.',
    );
    expect(traffic.writes()).toEqual([]);
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await reviewPaste(
      page,
      `READY=synthetic-limit-ready\nOVERSIZED=${oversized}`,
    );
    expect(await reviewRow(page, 2).locator('p').textContent()).toBe(
      'Value is over 64 KiB. Skipped.',
    );
    expect(traffic.writes()).toEqual([]);
    await createImport(page, 1);
    await importSettled(page);
    await importSheet(page)
      .getByText('Value over 64 KiB; not created.', { exact: true })
      .waitFor();
    expect(traffic.posts.map(({ name }) => name)).toEqual(['READY']);
  } finally {
    await visit.close();
  }
});
