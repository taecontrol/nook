import type { Browser, Page } from 'playwright';
import { expect } from 'vitest';
import { jsonRequest } from './authorizations.ts';
import type { TestRuntime } from './runtime.ts';
import {
  createSecret,
  listSecrets,
  replaceSecret,
  secretInput,
} from './vault.ts';
import { secretRow, vaultPage } from './vault-browser.ts';

export const revealPath = 'work/acme/STRIPE_KEY';
export const revealValue = 'sk_test_123';
export const revealIp = '2800:e2:1a80:3c1::7f2';
export const revealCountry = 'CO';
export function revealSecret(
  app: TestRuntime,
  path = revealPath,
  headers: Record<string, string> = {},
) {
  return jsonRequest(
    app,
    `/api/secrets/${encodeURIComponent(path)}/reveal`,
    undefined,
    headers,
  );
}
export async function setRevealValue(app: TestRuntime, value: string) {
  const stored = (await listSecrets(app)).find(
    (secret) => secret.path === revealPath,
  );
  const input = secretInput({ value });
  const response = stored
    ? await replaceSecret(app, revealPath, {
        ...input,
        expectedVersion: stored.version,
      })
    : await createSecret(app, input);
  expect(response.status).toBe(stored ? 200 : 201);
}
export async function openReveal(page: Page) {
  await secretRow(page, revealPath)
    .getByRole('button', { name: `Actions for ${revealPath}`, exact: true })
    .click();
  await page
    .getByRole('menuitem', { name: 'Reveal value…', exact: true })
    .click();
  return page.getByRole('dialog', { name: 'STRIPE_KEY', exact: true });
}
export const valueField = (page: Page) =>
  page.getByRole('textbox', { name: 'Value', exact: true });
export function revealRequests(requests: { path: string }[]) {
  return requests.filter((request) => request.path.endsWith('/reveal'));
}
export function revealPage(
  browser: Browser,
  options: Parameters<typeof vaultPage>[1] & { value?: string } = {},
) {
  return vaultPage(browser, {
    ...options,
    configure: async (page, app) => {
      await app.setBindings(app.bindings, { cf: { country: revealCountry } });
      await setRevealValue(app, options.value ?? revealValue);
      await page
        .context()
        .grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: app.origin,
        });
      await page.setExtraHTTPHeaders({ 'CF-Connecting-IP': revealIp });
      await page.clock.setFixedTime(new Date('2026-10-09T12:00:00Z'));
      await options.configure?.(page, app);
    },
  });
}
export async function storageHasValue(page: Page, value: string) {
  return page.evaluate(
    (privateValue) =>
      [localStorage, sessionStorage].some((storage) =>
        Array.from({ length: storage.length }, (_, i) =>
          storage.getItem(storage.key(i) ?? ''),
        ).some((item) => item?.includes(privateValue)),
      ),
    value,
  );
}
