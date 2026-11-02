import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { vaultPage } from './support/vault-browser.ts';
import { openImport, pasteField } from './support/vault-import-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it.each([
  { start: '/vault', bucket: 'me', width: 1280 },
  { start: '/vault?bucket=work/acme', bucket: 'work/acme', width: 1280 },
  { start: '/vault?bucket=work/acme', bucket: 'work/acme', width: 390 },
  { start: '/vault?bucket=work/deleted', bucket: 'me', width: 1280 },
])(
  'create and import initially select $bucket at $start on a $width px screen',
  async ({ start, bucket, width }) => {
    const visit = await vaultPage(browser, {
      start,
      viewport: { width, height: 900 },
    });
    const { page } = visit;
    try {
      if (bucket === 'work/acme') {
        const stored = page.getByRole('region', { name: 'Stored here' });
        await stored
          .getByRole('heading', { name: 'Stored here', exact: true })
          .waitFor();
        expect(await stored.getByText('4', { exact: true }).count()).toBe(1);
        expect(
          await stored.getByText('Updated', { exact: true }).isVisible(),
        ).toBe(width >= 640);
        const inherited = page.getByRole('region', { name: 'Inherited' });
        expect(
          await inherited
            .getByRole('heading', { name: 'Inherited', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await inherited.getByText('3', { exact: true }).count()).toBe(1);
      }
      await page
        .getByRole('button', { name: 'New secret', exact: true })
        .click();
      const sheet = page.getByRole('dialog');
      expect(
        await sheet.getByLabel('Bucket', { exact: true }).textContent(),
      ).toBe(bucket);
      await sheet.getByLabel('Bucket', { exact: true }).click();
      await page
        .getByRole('option', { name: 'work/globex', exact: true })
        .click();
      expect(
        await sheet
          .getByText('Agents working in work/globex find it.', { exact: true })
          .isVisible(),
      ).toBe(true);
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openImport(page);
      expect(
        await sheet
          .getByRole('combobox', { name: 'Bucket', exact: true })
          .textContent(),
      ).toBe(bucket);
      if (bucket === 'work/acme') {
        await sheet.getByLabel('Bucket', { exact: true }).click();
        await page.getByRole('option', { name: 'me', exact: true }).click();
        expect(
          await sheet
            .getByText('Agents working in any bucket find them.', {
              exact: true,
            })
            .isVisible(),
        ).toBe(true);
        await pasteField(page).fill('READY=synthetic-default-bucket');
        await sheet
          .getByRole('button', { name: 'Review keys', exact: true })
          .click();
        expect(
          await sheet
            .getByRole('heading', { name: 'Ready', exact: true })
            .isVisible(),
        ).toBe(true);
        expect(await sheet.getByText('1', { exact: true }).count()).toBe(1);
        expect(
          await sheet.getByText('1 of 1 checked', { exact: true }).isVisible(),
        ).toBe(true);
        expect(
          await sheet.getByLabel('Bucket', { exact: true }).textContent(),
        ).toBe('me');
        await sheet.getByLabel('Bucket', { exact: true }).click();
        await page
          .getByRole('option', { name: 'work/acme', exact: true })
          .click();
        await sheet
          .getByText(
            'Agents working in work/acme or a bucket inside it find them.',
            { exact: true },
          )
          .waitFor();
      }
      expect(visit.requests.filter(({ method }) => method !== 'GET')).toEqual(
        [],
      );
    } finally {
      await visit.close();
    }
  },
);
