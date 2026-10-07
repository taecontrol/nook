import { expect, it, onTestFinished } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { listSecrets } from './support/vault.ts';
import {
  createDraft,
  privateClientState,
  replaceDraft,
  secretRow,
  vaultPage,
} from './support/vault-browser.ts';

it.each([
  ['create', true],
  ['create', false],
  ['replace', true],
  ['replace', false],
] as const)(
  'E21: a missing key after an unconfirmed %s (committed: %s) resolves only by listing',
  async (op, committed) => {
    const browser = await launchTestBrowser();
    let visit: Awaited<ReturnType<typeof vaultPage>> | undefined;
    onTestFinished(async () => {
      try {
        await visit?.close();
      } finally {
        await browser.close();
      }
    });
    const attempts: string[] = [];
    const method = op === 'create' ? 'POST' : 'PUT';
    const path = `work/acme/${op === 'create' ? 'RESEND_API_KEY' : 'STRIPE_KEY'}`;
    visit = await vaultPage(browser.browser, {
      configure: async (page, app) => {
        await page.route('**/api/secrets**', async (route) => {
          if (route.request().method() !== method) return route.continue();
          attempts.push(route.request().postDataJSON().writeId);
          if (attempts.length !== 1) {
            const response = await route.fetch();
            expect(response.status()).toBe(503);
            expect((await response.json())._tag).toBe('VaultNotConfigured');
            return route.fulfill({ response });
          }
          if (committed)
            expect((await route.fetch()).status()).toBe(
              op === 'create' ? 201 : 200,
            );
          await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        });
      },
    });
    if (op === 'create') {
      const sheet = await createDraft(visit.page);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
    } else {
      await replaceDraft(visit.page);
      await visit.page
        .getByRole('alertdialog')
        .getByRole('button', { name: 'Replace value', exact: true })
        .click();
    }
    await visit.page
      .getByRole('alert')
      .filter({
        has: visit.page.getByRole('button', { name: 'Dismiss', exact: true }),
      })
      .waitFor();
    expect(
      (await listSecrets(visit.app)).some((secret) => secret.path === path),
    ).toBe(committed || op === 'replace');
    const feedback = visit.page.getByRole('alert').filter({
      has: visit.page.getByRole('button', { name: 'Dismiss', exact: true }),
    });
    const text = await feedback.innerText();
    expect(
      text,
      'The genuine Worker stored it before its encryption key became unavailable.',
    ).not.toContain('Nothing was stored.');
    expect(text).not.toContain('Nothing changed.');
    expect(text).toContain('Nook could not confirm whether');
    expect(await secretRow(visit.page, path).innerText()).toContain(
      'Confirming',
    );
    expect(attempts).toHaveLength(2);
    expect(new Set(attempts).size).toBe(1);
    expect(
      await privateClientState(visit.page, [
        'synthetic-browser-vault-value',
        'synthetic-browser-replacement',
      ]),
    ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    await feedback
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    const heading = committed
      ? op === 'create'
        ? 'Secret saved'
        : 'Value replaced'
      : 'Current secret state';
    await feedback
      .filter({ has: visit.page.getByText(heading, { exact: true }) })
      .waitFor();
    if (committed || op === 'replace')
      expect(await secretRow(visit.page, path).innerText()).not.toContain(
        'Confirming',
      );
    else expect(await secretRow(visit.page, path).count()).toBe(0);
    if (!committed)
      expect(await feedback.innerText()).toContain(
        op === 'create'
          ? `${path} is no longer stored.`
          : `${path} is still stored with the version you last saw.`,
      );
    expect(attempts).toHaveLength(2);
  },
);
