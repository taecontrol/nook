import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { importBucket } from './fixtures/vault-import.ts';
import { listSecrets } from './support/vault.ts';
import { createDraft } from './support/vault-browser.ts';
import {
  createImport,
  expectCreated,
  importPage,
  importSettled,
  importSheet,
  reviewPaste,
  reviewRow,
  runRow,
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

it('NUL and lone-surrogate values appear under Skipped in review and results and only the valid key is created', async () => {
  const visit = await importPage(browser);
  const { page, traffic, app } = visit;
  const text =
    'NUL_TOKEN="a\u0000b"\nSURROGATE_TOKEN=a\uD800b\nOK_TOKEN=fine\n';
  const invalid = [
    { line: 1, name: 'NUL_TOKEN', reason: 'Value contains NUL. Skipped.' },
    {
      line: 2,
      name: 'SURROGATE_TOKEN',
      reason: 'Value is not valid Unicode. Skipped.',
    },
  ];
  try {
    const before = (await listSecrets(app)).map(({ path }) => path);
    const sheet = await reviewPaste(page, text);
    const skipped = sheet.locator('section').filter({
      has: page.getByRole('heading', { name: 'Skipped', exact: true }),
    });
    for (const { line, name, reason } of invalid) {
      const row = reviewRow(page, line);
      expect.soft(await row.locator('p').allTextContents()).toEqual([reason]);
      expect
        .soft(await skipped.locator(`[data-row="${name}"]`).count())
        .toBe(1);
      expect.soft(await row.locator('p.text-muted-foreground').count()).toBe(1);
    }
    expect(
      await sheet
        .getByRole('heading', { name: 'Needs a fix', exact: true })
        .count(),
    ).toBe(0);
    expect(traffic.writes().length).toBe(0);
    expect(
      await sheet
        .getByRole('button', { name: 'Create 1 secret', exact: true })
        .count(),
    ).toBe(1);
    await createImport(page, 1);
    await importSettled(page);
    for (const { name } of invalid) {
      const row = runRow(page, name);
      expect(
        await row
          .getByText('Invalid value; not created.', { exact: true })
          .count(),
      ).toBe(1);
      expect(await skipped.getByText(name, { exact: true }).count()).toBe(1);
    }
    await expectCreated(page, ['OK_TOKEN']);
    expect(traffic.posts.map(({ name }) => name)).toEqual(['OK_TOKEN']);
    expect(
      (await listSecrets(app))
        .filter(({ path }) => !before.includes(path))
        .map(({ path }) => path),
    ).toEqual([`${importBucket}/OK_TOKEN`]);
  } finally {
    await visit.close();
  }
});
