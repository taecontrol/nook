import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { vaultPage } from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('Home does not describe Vault as unavailable when its tool link opens the real Vault', async () => {
  const visit = await vaultPage(browser, { fresh: true, start: '/' });
  try {
    const { page } = visit;
    await page
      .getByRole('heading', { name: "You're signed in", exact: true })
      .waitFor();
    const session = await page
      .getByRole('region', { name: 'Owner access', exact: true })
      .innerText();
    const link = page
      .getByRole('region', { name: 'Tools', exact: true })
      .getByRole('link', { name: /Vault/ });
    expect(await link.getAttribute('href')).toBe('/vault');
    await link.click();
    await page.getByRole('heading', { name: 'me', exact: true }).waitFor();
    await expect
      .poll(() =>
        page
          .getByRole('region', { name: 'Secrets in me', exact: true })
          .getByRole('button', { name: 'New secret', exact: true })
          .isEnabled(),
      )
      .toBe(true);
    expect(
      visit.requests.some(
        (request) =>
          request.method === 'GET' && request.path === '/api/secrets',
      ),
      'Vault loaded its genuine metadata endpoint',
    ).toBe(true);
    expect(
      session,
      'An available tool must not be described as unavailable',
    ).not.toMatch(/\bVault\b[^.]*\bnot available\b/i);
  } finally {
    await visit.close();
  }
});
