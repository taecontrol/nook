import { randomUUID } from 'node:crypto';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import {
  createSecret,
  deleteSecret,
  listSecrets,
  replaceSecret,
  secretInput,
  secretRows,
} from './support/vault.ts';
import {
  createDraft,
  openSecretMenu,
  privateClientState,
  replaceDraft,
  secretRow,
  vaultPage,
} from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('E19/E23: Home Vault intent preloads bucket and secret metadata before navigation and reuses it', async () => {
  const gate = deferred();
  const visit = await vaultPage(browser, {
    start: '/',
    configure: async (page) => {
      await page.route(/\/api\/(buckets|secrets)$/, async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  const { page } = visit;
  const metadataReads = () =>
    visit.requests
      .filter((request) =>
        ['/api/buckets', '/api/secrets'].includes(request.path),
      )
      .map((request) => request.path)
      .sort();
  try {
    const link = page
      .getByRole('region', { name: 'Tools', exact: true })
      .getByRole('link', { name: /Vault/ });
    await link.hover();
    await expect.poll(metadataReads).toEqual(['/api/buckets', '/api/secrets']);
    expect(new URL(page.url()).pathname).toBe('/');
    gate.resolve();
    await page.waitForLoadState('networkidle');
    await link.click();
    await secretRow(page, 'me/GITHUB_TOKEN').waitFor();
    expect(metadataReads()).toEqual(['/api/buckets', '/api/secrets']);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E19: the outline counts secrets and URL selection separates stored and inherited groups', async () => {
  const visit = await vaultPage(browser, { start: '/' });
  const { page } = visit;
  try {
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await page.getByRole('heading', { name: 'me', exact: true }).waitFor();
    const tree = page.getByRole('list', { name: 'Buckets', exact: true });
    await expect
      .poll(() => tree.locator('[data-path="work/acme"]').innerText())
      .toMatch(/4\s*secrets/);
    await tree.locator('[data-path="work/acme"]').getByRole('link').click();
    expect(new URL(page.url()).searchParams.get('bucket')).toBe('work/acme');
    const own = page.getByRole('region', { name: 'Stored here' });
    expect(await own.locator('[data-secret]').count()).toBe(4);
    const inherited = page.getByRole('region', { name: 'Inherited' });
    expect(await inherited.getByRole('link').allTextContents()).toEqual([
      'work',
      'me',
    ]);
    expect(await inherited.locator('[data-secret]').count()).toBe(3);
    expect(await inherited.getByRole('button').count()).toBe(0);
    expect(await page.locator('[data-secret*="personal"]').count()).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E19: phone drill-in supports All buckets and browser Back', async () => {
  const visit = await vaultPage(browser, {
    start: '/vault',
    viewport: { width: 390, height: 844 },
  });
  const { page } = visit;
  try {
    const bucket = page
      .getByRole('list', { name: 'Buckets', exact: true })
      .locator('[data-path="work/acme"]')
      .getByRole('link');
    await bucket.click();
    await page.getByRole('region', { name: 'Stored here' }).waitFor();
    await page.getByRole('link', { name: 'All buckets', exact: true }).click();
    expect(new URL(page.url()).searchParams.has('bucket')).toBe(false);
    await bucket.click();
    await page.goBack();
    await bucket.waitFor({ state: 'visible' });
    expect(new URL(page.url()).searchParams.has('bucket')).toBe(false);
  } finally {
    await visit.close();
  }
});
it('the Vault bucket selection follows both sides of the desktop breakpoint', async () => {
  const visit = await vaultPage(browser, {
    start: '/vault',
    viewport: { width: 1023, height: 900 },
  });
  const { page } = visit;
  try {
    const bucket = page
      .getByRole('list', { name: 'Buckets', exact: true })
      .locator('[data-path="me"]')
      .getByRole('link');
    await bucket.waitFor();
    expect(await bucket.getAttribute('aria-current')).toBeNull();
    await page.setViewportSize({ width: 1024, height: 900 });
    await expect.poll(() => bucket.getAttribute('aria-current')).toBe('page');
    await page.setViewportSize({ width: 1023, height: 900 });
    await expect.poll(() => bucket.getAttribute('aria-current')).toBeNull();
    expect(new URL(page.url()).searchParams.has('bucket')).toBe(false);
  } finally {
    await visit.close();
  }
});
it.each([false, true])(
  'E19: create is optimistic and settled values disappear from DOM, Query cache and mutation state (submit burst: %s)',
  async (submitBurst) => {
    const gate = deferred();
    const visit = await vaultPage(browser, {
      configure: async (page) => {
        await page.route('**/api/secrets', async (route) => {
          if (route.request().method() === 'POST') await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    const { page } = visit;
    const value = `synthetic-client-${randomUUID()}`;
    try {
      const sheet = await createDraft(page, { value });
      const field = sheet.getByRole('textbox', { name: 'Value', exact: true });
      expect(await field.getAttribute('autocomplete')).toBe('off');
      expect(await field.getAttribute('spellcheck')).toBe('false');
      if (submitBurst)
        await sheet.locator('form').evaluate((element) => {
          const form = element as HTMLFormElement;
          form.requestSubmit();
          form.requestSubmit();
        });
      else
        await sheet
          .getByRole('button', { name: 'Save secret', exact: true })
          .click();
      const row = secretRow(page, 'work/acme/RESEND_API_KEY');
      await row.waitFor();
      expect(await row.innerText()).toContain(
        'Transactional email for staging',
      );
      expect(await row.innerText()).toContain('Saving');
      expect(
        (await listSecrets(visit.app)).some(
          (secret) => secret.name === 'RESEND_API_KEY',
        ),
      ).toBe(false);
      if (submitBurst) {
        expect(
          await page
            .getByRole('button', { name: 'New secret', exact: true })
            .isEnabled(),
        ).toBe(false);
        await secretRow(page, 'work/acme/STRIPE_KEY')
          .getByRole('button', {
            name: 'Actions for work/acme/STRIPE_KEY',
            exact: true,
          })
          .click();
        const remove = page.getByRole('menuitem', {
          name: 'Delete secret…',
          exact: true,
        });
        const replace = page.getByRole('menuitem', {
          name: 'Replace value…',
          exact: true,
        });
        expect(await remove.isEnabled()).toBe(false);
        expect(await replace.isEnabled()).toBe(false);
        await remove.click({ force: true });
        await remove.press('Enter');
        expect(await page.getByRole('alertdialog').count()).toBe(0);
        await page.keyboard.press('Escape');
      }
      gate.resolve();
      if (submitBurst) {
        await page.waitForLoadState('networkidle');
        expect(
          visit.requests.filter((request) => request.method === 'POST'),
        ).toHaveLength(1);
        expect(await page.getByRole('dialog').count()).toBe(0);
      }
      await page
        .getByRole('alert')
        .filter({ has: page.getByText('Secret saved', { exact: true }) })
        .waitFor();
      await expect
        .poll(() => privateClientState(page, [value, ...visit.values]))
        .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
it('E20: replacement and deletion require confirmation; Back and Cancel change nothing', async () => {
  const visit = await vaultPage(browser);
  const { page } = visit;
  try {
    const before = await secretRows(visit.app);
    await openSecretMenu(page, 'work/acme/STRIPE_KEY', 'Replace value…');
    const sheet = page.getByRole('dialog');
    expect(
      await sheet
        .getByRole('textbox', { name: 'New value', exact: true })
        .inputValue(),
    ).toBe('');
    await sheet
      .getByRole('button', { name: 'Replace value…', exact: true })
      .click();
    expect(await page.getByRole('alertdialog').count()).toBe(0);
    await sheet
      .getByRole('textbox', { name: 'New value', exact: true })
      .fill('synthetic-replace-confirm');
    await sheet
      .getByRole('textbox', { name: 'Description', exact: true })
      .fill('Replacement description');
    await sheet
      .getByRole('button', { name: 'Replace value…', exact: true })
      .click();
    const confirm = page.getByRole('alertdialog');
    expect(await confirm.getByRole('heading').innerText()).toBe(
      'Replace the value of work/acme/STRIPE_KEY?',
    );
    await confirm.getByRole('button', { name: 'Back', exact: true }).click();
    expect(await secretRows(visit.app)).toEqual(before);
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    await openSecretMenu(page, 'work/acme/DATABASE_URL', 'Delete secret…');
    expect(await confirm.getByRole('heading').innerText()).toBe(
      'Delete work/acme/DATABASE_URL?',
    );
    await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await secretRows(visit.app)).toEqual(before);
  } finally {
    await visit.close();
  }
});
it.each(['replace', 'delete'])(
  'E20: confirmed %s updates the visible row before HTTP settles',
  async (operation) => {
    const gate = deferred();
    const visit = await vaultPage(browser, {
      configure: async (page) => {
        await page.route('**/api/secrets/*', async (route) => {
          await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    const { page } = visit;
    try {
      if (operation === 'replace') await replaceDraft(page);
      else await openSecretMenu(page, 'work/acme/STRIPE_KEY', 'Delete secret…');
      await page
        .getByRole('alertdialog')
        .getByRole('button', {
          name: operation === 'replace' ? 'Replace value' : 'Delete secret',
          exact: true,
        })
        .click();
      if (operation === 'replace')
        await expect
          .poll(() => secretRow(page, 'work/acme/STRIPE_KEY').innerText())
          .toContain('Replacement description');
      else
        await secretRow(page, 'work/acme/STRIPE_KEY').waitFor({
          state: 'detached',
        });
      expect(
        (await listSecrets(visit.app)).find(
          (secret) => secret.name === 'STRIPE_KEY',
        )!.description,
      ).toBe('Stripe test-mode secret key');
      gate.resolve();
      await page
        .getByRole('alert')
        .filter({ hasText: operation === 'replace' ? 'Replaced' : 'Deleted' })
        .waitFor();
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
it('E20: a known duplicate sends no request; a raced duplicate refetches and reopens the Sheet', async () => {
  let race = false;
  const visit = await vaultPage(browser, {
    configure: async (page, app) => {
      await page.route('**/api/secrets', async (route) => {
        if (race && route.request().method() === 'POST') {
          race = false;
          expect(
            (await createSecret(app, secretInput({ name: 'RESEND_API_KEY' })))
              .status,
          ).toBe(201);
        }
        await route.continue();
      });
    },
  });
  const { page } = visit;
  try {
    let sheet = await createDraft(page, { name: 'STRIPE_KEY' });
    const before = visit.requests.filter(
      (request) => request.method === 'POST',
    ).length;
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await sheet
      .getByText('work/acme/STRIPE_KEY already exists.', { exact: true })
      .waitFor();
    expect(
      visit.requests.filter((request) => request.method === 'POST'),
    ).toHaveLength(before);
    await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
    race = true;
    sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await page
      .getByRole('dialog')
      .getByText('work/acme/RESEND_API_KEY already exists.', { exact: true })
      .waitFor();
    expect(
      (await page
        .getByRole('dialog')
        .getByRole('textbox', { name: 'Value', exact: true })
        .inputValue()) === '',
    ).toBe(true);
    expect(
      await privateClientState(page, ['synthetic-browser-vault-value']),
    ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    expect(
      (await listSecrets(visit.app)).filter(
        (secret) => secret.name === 'RESEND_API_KEY',
      ),
    ).toHaveLength(1);
  } finally {
    await visit.close();
  }
});
it.each(['storage', 'network'])(
  'E21: an unconfirmed write resends the same id and never announces premature success (%s)',
  async (failure) => {
    const ids: string[] = [];
    const gate = deferred();
    const visit = await vaultPage(browser, {
      configure: async (page) => {
        await page.route('**/api/secrets', async (route) => {
          if (route.request().method() !== 'POST') return route.continue();
          ids.push(route.request().postDataJSON().writeId);
          if (ids.length < 3) {
            if (failure === 'network') return route.abort('failed');
            return route.fulfill({
              status: 503,
              json: { _tag: 'ServiceUnavailable' },
            });
          }
          await gate.promise;
          return route.continue().catch(() => {});
        });
      },
    });
    const { page } = visit;
    try {
      const sheet = await createDraft(page);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      await expect.poll(() => ids.length).toBe(3);
      expect(new Set(ids).size).toBe(1);
      expect(await page.getByRole('alert').innerText()).not.toMatch(
        /Stored work\/acme/,
      );
      gate.resolve();
      await page
        .getByRole('alert')
        .filter({ has: page.getByText('Secret saved', { exact: true }) })
        .waitFor();
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
async function fetchingVault(page: Page) {
  return page.evaluate(() => {
    const element = document.querySelector('#root > *');
    const key = Object.keys(element ?? {}).find((entry) =>
      entry.startsWith('__reactFiber$'),
    );
    type Fiber = {
      return?: Fiber;
      memoizedProps?: {
        client?: { isFetching(filters: { queryKey: string[] }): number };
      };
    };
    let fiber = key
      ? (element as unknown as Record<string, Fiber>)[key]
      : undefined;
    while (fiber) {
      const client = fiber.memoizedProps?.client;
      if (client?.isFetching)
        return client.isFetching({ queryKey: ['vault', 'secrets'] });
      fiber = fiber.return;
    }
    return -1;
  });
}

it.each([false, true])(
  'E21: a persistent D1 failure keeps an unconfirmed row until a successful list settles it (earlier refresh: %s)',
  async (earlierRefresh) => {
    const staleList = deferred();
    const writeGate = deferred();
    if (!earlierRefresh) writeGate.resolve();
    let holdList = false;
    let snapshotReady = false;
    let snapshotReleased = false;
    const visit = await vaultPage(browser, {
      configure: async (page, app) => {
        await page.route('**/api/secrets', async (route) => {
          if (route.request().method() === 'POST') await writeGate.promise;
          if (route.request().method() === 'GET' && holdList) {
            holdList = false;
            const response = await route.fetch();
            expect(response.status()).toBe(200);
            snapshotReady = true;
            await staleList.promise;
            try {
              await route.fulfill({ response });
            } catch {
              // The production cancelQueries call aborts this older request.
            } finally {
              snapshotReleased = true;
            }
            return;
          }
          await route.continue().catch(() => {});
        });
        await (await app.mf.getD1Database('DB'))
          .prepare(
            "CREATE TRIGGER vault_failure BEFORE INSERT ON secrets BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
          )
          .run();
      },
    });
    const { page } = visit;
    try {
      if (earlierRefresh) {
        await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
        holdList = true;
        await page.evaluate(() =>
          window.dispatchEvent(new Event('visibilitychange')),
        );
        await expect.poll(() => snapshotReady).toBe(true);
      }
      const sheet = await createDraft(page);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      if (earlierRefresh) {
        await secretRow(page, 'work/acme/RESEND_API_KEY').waitFor();
        expect(
          await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
        ).toContain('Saving');
        staleList.resolve();
        await expect.poll(() => snapshotReleased).toBe(true);
        await expect.poll(() => fetchingVault(page)).toBe(0);
        writeGate.resolve();
      }
      await page
        .getByRole('alert')
        .filter({
          hasText:
            'Nook could not confirm whether work/acme/RESEND_API_KEY was stored.',
        })
        .waitFor();
      expect(
        await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
      ).toContain('Confirming');
      expect(await page.getByRole('alert').innerText()).not.toContain(
        'Nothing was stored',
      );
      expect(
        visit.requests.filter((request) => request.method === 'POST'),
      ).toHaveLength(3);
      await page
        .getByRole('alert')
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await secretRow(page, 'work/acme/RESEND_API_KEY').waitFor({
        state: 'detached',
      });
      expect(await page.getByRole('alert').innerText()).toContain(
        'is no longer stored',
      );
    } finally {
      staleList.resolve();
      writeGate.resolve();
      await visit.close();
    }
  },
);
it('E21: a lost response after commit reconciles pending metadata by version on the next list', async () => {
  let requests = 0;
  const visit = await vaultPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        if (requests++ === 0) await route.fetch();
        return route.fulfill({
          status: 503,
          json: { _tag: 'ServiceUnavailable' },
        });
      });
    },
  });
  const { page } = visit;
  try {
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'could not confirm' })
      .waitFor();
    expect(
      (await listSecrets(visit.app)).some(
        (secret) => secret.name === 'RESEND_API_KEY',
      ),
    ).toBe(true);
    await page
      .getByRole('alert')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ has: page.getByText('Secret saved', { exact: true }) })
      .waitFor();
    expect(
      await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
    ).not.toContain('Confirming');
  } finally {
    await visit.close();
  }
});
it('E21: a negative retry after ambiguity stays pending until listing describes the current state', async () => {
  let requests = 0;
  const visit = await vaultPage(browser, {
    configure: async (page, app) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        if (requests++ === 0) {
          expect(
            (await createSecret(app, secretInput({ name: 'RESEND_API_KEY' })))
              .status,
          ).toBe(201);
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        }
        return route.continue();
      });
    },
  });
  try {
    const sheet = await createDraft(visit.page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await visit.page
      .getByRole('alert')
      .filter({ hasText: 'could not confirm' })
      .waitFor();
    expect(await visit.page.getByRole('alert').innerText()).not.toMatch(
      /nothing was stored/i,
    );
    expect(
      await secretRow(visit.page, 'work/acme/RESEND_API_KEY').innerText(),
    ).toContain('Confirming');
    await visit.page
      .getByRole('alert')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await visit.page
      .getByRole('alert')
      .filter({ hasText: 'now exists' })
      .waitFor();
  } finally {
    await visit.close();
  }
});
it('E21: an expired session after a lost committed response stays unconfirmed until an authorized list', async () => {
  let requests = 0;
  const visit = await vaultPage(browser, {
    configure: async (page, app) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        if (requests++ !== 0) return route.continue();
        await route.fetch();
        await app.setBindings({ ...app.bindings, LOCAL_OWNER: '' });
        return route.fulfill({
          status: 503,
          json: { _tag: 'ServiceUnavailable' },
        });
      });
    },
  });
  const { page } = visit;
  try {
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ hasText: 'could not confirm' })
      .waitFor();
    expect(await page.getByRole('alert').innerText()).not.toMatch(
      /nothing was stored/i,
    );
    expect(
      await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
    ).toContain('Confirming');
    await visit.app.setBindings(visit.app.bindings);
    await page
      .getByRole('alert')
      .getByRole('button', { name: 'Try again', exact: true })
      .click();
    await page
      .getByRole('alert')
      .filter({ has: page.getByText('Secret saved', { exact: true }) })
      .waitFor();
    expect(
      await secretRow(page, 'work/acme/RESEND_API_KEY').innerText(),
    ).not.toContain('Confirming');
  } finally {
    await visit.close();
  }
});
it.each(['InvalidSecret', 'VaultNotConfigured'])(
  'E21: definitive %s rolls back and truthfully explains that nothing was stored',
  async (tag) => {
    const visit = await vaultPage(browser, {
      configure: async (page, app) => {
        if (tag === 'VaultNotConfigured')
          await app.setBindings({
            LOCAL_OWNER: 'synthetic-owner',
            LOCAL_ORIGIN: app.origin,
          });
        else
          await page.route('**/api/secrets', (route) =>
            route.request().method() === 'POST'
              ? route.fulfill({
                  status: 400,
                  json: { _tag: 'InvalidSecret', message: 'Enter a value.' },
                })
              : route.continue(),
          );
      },
    });
    try {
      const sheet = await createDraft(visit.page);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      await visit.page
        .getByRole('alert')
        .filter({ hasText: /nothing was stored/i })
        .waitFor();
      if (tag === 'VaultNotConfigured')
        expect(await visit.page.getByRole('alert').innerText()).toContain(
          'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
        );
      expect(
        await secretRow(visit.page, 'work/acme/RESEND_API_KEY').count(),
      ).toBe(0);
      expect(
        visit.requests.filter((request) => request.method === 'POST'),
      ).toHaveLength(1);
    } finally {
      await visit.close();
    }
  },
);
it('E21: SecretChanged rolls back, refetches current metadata and displays the concurrency message', async () => {
  const visit = await vaultPage(browser);
  try {
    await secretRow(visit.page, 'work/acme/STRIPE_KEY').waitFor();
    const target = (await listSecrets(visit.app)).find(
      (secret) => secret.name === 'STRIPE_KEY',
    )!;
    expect(
      (
        await replaceSecret(visit.app, target.path, {
          ...secretInput({ description: 'Another session description' }),
          expectedVersion: target.version,
        })
      ).status,
    ).toBe(200);
    await replaceDraft(visit.page);
    await visit.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Replace value', exact: true })
      .click();
    await visit.page
      .getByRole('alert')
      .filter({
        hasText:
          'work/acme/STRIPE_KEY changed in another session. Review it and try again.',
      })
      .waitFor();
    await expect
      .poll(() => secretRow(visit.page, target.path).innerText())
      .toContain('Another session description');
  } finally {
    await visit.close();
  }
});
it('E21: deleting a missing secret removes its stale row and says it is no longer stored', async () => {
  const visit = await vaultPage(browser);
  try {
    await secretRow(visit.page, 'work/acme/DATABASE_URL').waitFor();
    const target = (await listSecrets(visit.app)).find(
      (secret) => secret.name === 'DATABASE_URL',
    )!;
    expect(
      (await deleteSecret(visit.app, target.path, target.version)).status,
    ).toBe(204);
    await openSecretMenu(visit.page, target.path, 'Delete secret…');
    await visit.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete secret', exact: true })
      .click();
    await visit.page
      .getByRole('alert')
      .filter({ hasText: 'work/acme/DATABASE_URL is no longer stored.' })
      .waitFor();
    expect(await secretRow(visit.page, target.path).count()).toBe(0);
  } finally {
    await visit.close();
  }
});
it('E22: Buckets shows the shared Delete its secrets first message', async () => {
  const visit = await vaultPage(browser, { start: '/buckets' });
  try {
    expect(
      (await createSecret(visit.app, secretInput({ bucket: 'work/globex' })))
        .status,
    ).toBe(201);
    await visit.page
      .getByRole('button', { name: 'Actions for work/globex', exact: true })
      .click();
    await visit.page
      .getByRole('menuitem', { name: 'Delete bucket…', exact: true })
      .click();
    await visit.page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Delete bucket', exact: true })
      .click();
    await visit.page
      .getByRole('alert')
      .filter({ hasText: 'Delete its secrets first.' })
      .waitFor();
  } finally {
    await visit.close();
  }
});
