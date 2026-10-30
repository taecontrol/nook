import type { Page } from 'playwright';
import { expect } from 'vitest';
import { importBucket } from '../fixtures/vault-import.ts';
import { deferred } from './machines.ts';
import { createSecret, secretInput, type vaultRuntime } from './vault.ts';
import { failImportKey, restoreImportStorage } from './vault-import-browser.ts';

export type LossState =
  | 'committed'
  | 'other'
  | 'absent'
  | 'negative'
  | 'key-missing';
export const lostName = 'LOST_KEY';
export const lostValue = 'synthetic-import-lost-value';
export const otherValue = 'synthetic-import-other-session';

export async function loseImportResponses(
  page: Page,
  app: Awaited<ReturnType<typeof vaultRuntime>>,
  state: LossState,
) {
  if (['other', 'absent', 'negative'].includes(state))
    await failImportKey(app, lostName);
  const list = deferred();
  const responses: number[] = [];
  let armed = false;
  let losing = true;
  let reads = 0;
  await page.route('**/api/secrets', async (route) => {
    if (route.request().method() === 'GET') {
      if (armed) {
        reads += 1;
        await list.promise;
      }
      return route.continue().catch(() => {});
    }
    if (!losing) return route.continue();
    const response = await route.fetch();
    responses.push(response.status());
    if (responses.length === 1) await changeAfterLoss(app, state);
    const negative =
      ['negative', 'key-missing'].includes(state) && responses.length > 1;
    if (negative) return route.fulfill({ response });
    return route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } });
  });
  return {
    responses,
    reads: () => reads,
    arm: () => {
      armed = true;
    },
    release: () => list.resolve(),
    allowRetry: () => {
      losing = false;
    },
  };
}

async function changeAfterLoss(
  app: Awaited<ReturnType<typeof vaultRuntime>>,
  state: LossState,
) {
  if (state === 'key-missing') {
    await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
    return;
  }
  if (state !== 'other' && state !== 'negative') return;
  await restoreImportStorage(app);
  expect(
    (
      await createSecret(
        app,
        secretInput({
          bucket: importBucket,
          name: lostName,
          value: otherValue,
        }),
      )
    ).status,
  ).toBe(201);
}
