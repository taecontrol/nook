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
  { start: '/vault', bucket: 'me' },
  { start: '/vault?bucket=work/acme', bucket: 'work/acme' },
  { start: '/vault?bucket=work/deleted', bucket: 'me' },
])(
  'create and import initially select $bucket at $start',
  async ({ start, bucket }) => {
    const visit = await vaultPage(browser, { start });
    const { page } = visit;
    try {
      await page
        .getByRole('button', { name: 'New secret', exact: true })
        .click();
      const sheet = page.getByRole('dialog');
      expect(
        await sheet
          .getByRole('combobox', { name: 'Bucket', exact: true })
          .textContent(),
      ).toBe(bucket);
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
      await openImport(page);
      expect(
        await sheet
          .getByRole('combobox', { name: 'Bucket', exact: true })
          .textContent(),
      ).toBe(bucket);
      if (bucket === 'work/acme') {
        expect(
          await page.locator('#stored-heading').getAttribute('class'),
        ).toBe(
          'text-xs font-medium tracking-wider text-muted-foreground uppercase',
        );
        await pasteField(page).fill('READY=synthetic-default-bucket');
        await sheet
          .getByRole('button', { name: 'Review keys', exact: true })
          .click();
        expect(
          await sheet
            .getByRole('heading', { name: 'Ready', exact: true })
            .getAttribute('class'),
        ).toBe(
          'text-xs font-medium tracking-wider text-muted-foreground uppercase',
        );
      }
      expect(visit.requests.filter(({ method }) => method !== 'GET')).toEqual(
        [],
      );
    } finally {
      await visit.close();
    }
  },
);
