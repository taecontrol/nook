import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { listSecrets } from './support/vault.ts';
import { createDraft, vaultPage } from './support/vault-browser.ts';

it('E21: a missing key after a lost committed response cannot prove that nothing was stored', async ({
  onTestFinished,
}) => {
  const browser = await launchTestBrowser();
  let visit: Awaited<ReturnType<typeof vaultPage>> | undefined;
  onTestFinished(async () => {
    try {
      await visit?.close();
    } finally {
      await browser.close();
    }
  });
  let attempts = 0;
  visit = await vaultPage(browser.browser, {
    configure: async (page, app) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST' || attempts++ !== 0)
          return route.continue();
        expect((await route.fetch()).status()).toBe(201);
        await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
        return route.fulfill({
          status: 503,
          json: { _tag: 'ServiceUnavailable' },
        });
      });
    },
  });
  const sheet = await createDraft(visit.page);
  await sheet.getByRole('button', { name: 'Save secret', exact: true }).click();
  await visit.page
    .getByRole('alert')
    .filter({
      has: visit.page.getByRole('button', { name: 'Dismiss', exact: true }),
    })
    .waitFor();
  expect(
    (await listSecrets(visit.app)).some(
      (secret) => secret.name === 'RESEND_API_KEY',
    ),
  ).toBe(true);
  const text = await visit.page
    .getByRole('alert')
    .filter({
      has: visit.page.getByRole('button', { name: 'Dismiss', exact: true }),
    })
    .innerText();
  expect(
    text,
    'The genuine Worker stored it before its encryption key became unavailable.',
  ).not.toContain('Nothing was stored.');
});
