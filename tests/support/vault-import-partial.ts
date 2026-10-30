import type { Page, Route } from 'playwright';
import { expect } from 'vitest';
import { deferred } from './machines.ts';
import type { vaultRuntime } from './vault.ts';

export async function partialImportResults(
  page: Page,
  app: Awaited<ReturnType<typeof vaultRuntime>>,
) {
  const othersCreated = deferred();
  const keyRestored = deferred();
  let created = 0;
  let importing = false;
  let loseList = true;
  let closing = false;

  async function listResponse(route: Route) {
    const response = await route.fetch();
    if (importing && loseList) {
      loseList = false;
      expect(response.status()).toBe(200);
      return route.fulfill({
        status: 503,
        json: { _tag: 'ServiceUnavailable' },
      });
    }
    return route.fulfill({ response });
  }
  async function definitiveFailure(route: Route) {
    // Wait for the six ordinary commits, keeping the transient installation
    // failure from affecting another key. The last key waits for restoration.
    await othersCreated.promise;
    if (closing) return route.abort().catch(() => {});
    await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
    try {
      const response = await route.fetch();
      expect(response.status()).toBe(503);
      expect((await response.json())._tag).toBe('VaultNotConfigured');
      await route.fulfill({ response });
    } finally {
      await app.setBindings(app.bindings);
      keyRestored.resolve();
    }
  }
  async function unconfirmed(route: Route) {
    await keyRestored.promise;
    if (closing) return route.abort().catch(() => {});
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    return route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } });
  }
  await page.route('**/api/secrets', async (route) => {
    if (route.request().method() === 'GET') return listResponse(route);
    importing = true;
    const { name } = route.request().postDataJSON();
    if (name === 'STRIPE_WEBHOOK_SECRET') return definitiveFailure(route);
    if (name === 'GITHUB_APP_ID') return unconfirmed(route);
    const response = await route.fetch();
    expect(response.status()).toBe(201);
    if (++created === 6) othersCreated.resolve();
    return route.fulfill({ response });
  });
  return () => {
    closing = true;
    othersCreated.resolve();
    keyRestored.resolve();
  };
}
