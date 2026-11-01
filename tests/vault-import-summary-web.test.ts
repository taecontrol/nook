import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  createImport,
  importPage,
  importSheet,
  reviewPaste,
} from './support/vault-import-browser.ts';
import { partialImportResults } from './support/vault-import-partial.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('import progress and results keep the same counts and wording in the sheet and notice', async () => {
  const gate = deferred();
  let release = () => {};
  const visit = await importPage(browser, {
    configure: async (page, app) => {
      release = await partialImportResults(page, app);
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() === 'POST') await gate.promise;
        await route.fallback();
      });
    },
  });
  const { page } = visit;
  try {
    await reviewPaste(page);
    await createImport(page, 8);
    const sheet = importSheet(page);
    await sheet
      .getByRole('heading', { name: 'Importing…', exact: true })
      .waitFor();
    expect(
      await sheet.getByText('0 of 8 created', { exact: true }).count(),
    ).toBe(1);
    expect(await sheet.getByText('0%', { exact: true }).count()).toBe(1);
    expect(
      await sheet
        .getByText(/Closing this or opening another page/)
        .textContent(),
    ).toBe(
      'Closing this or opening another page doesn’t stop the import. New secret, Replace and Delete are paused until it finishes.',
    );
    await sheet
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    const notice = page.getByRole('alert');
    await notice.getByText('Importing secrets…', { exact: true }).waitFor();
    expect(await notice.locator('p').textContent()).toBe(
      '0 of 8 created in work/acme/api. New secret, Replace and Delete are paused until it finishes.',
    );
    expect(
      await notice
        .getByRole('button', { name: 'Show progress', exact: true })
        .count(),
    ).toBe(1);
    gate.resolve();
    await notice
      .getByText('Import finished with problems', { exact: true })
      .waitFor();
    expect(await notice.locator('p').textContent()).toBe(
      '6 created in work/acme/api; 2 need another try.',
    );
    await notice
      .getByRole('button', { name: 'Show results', exact: true })
      .click();
    await sheet
      .getByRole('heading', {
        name: 'Import finished with problems',
        exact: true,
      })
      .waitFor();
    expect(
      await sheet.locator('[data-slot="sheet-description"]').textContent(),
    ).toBe('6 secrets created in work/acme/api. 2 need another try.');
    expect(
      await sheet.getByText('6 of 8 created', { exact: true }).count(),
    ).toBe(1);
    expect(await sheet.getByText('75%', { exact: true }).count()).toBe(1);
    expect(
      await sheet
        .getByRole('button', { name: 'Retry failed', exact: true })
        .isEnabled(),
    ).toBe(true);
  } finally {
    gate.resolve();
    release();
    await visit.close();
  }
});
