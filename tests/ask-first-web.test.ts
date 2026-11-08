import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { jsonRequest } from './support/authorizations.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import { setMark, stripe } from './support/owner-approval.ts';
import {
  type ApprovalApp,
  approvalBrowserPage,
  approvalNow,
  approvalWebApp,
  expectSlashBreaks,
} from './support/owner-approval-browser.ts';
import { expectNoOverflow } from './support/page-checks.ts';
import {
  createSecret,
  deleteSecret,
  listSecrets,
  secretInput,
} from './support/vault.ts';
import {
  createDraft,
  openSecretMenu,
  secretRow,
} from './support/vault-browser.ts';

import {
  createImport,
  importSettled,
  importSheet,
  reviewPaste,
} from './support/vault-import-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
let app: ApprovalApp;
let ui: Awaited<ReturnType<typeof approvalBrowserPage>>;
let page: Page;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser());
beforeEach(async () => {
  app = await approvalWebApp();
  ui = await approvalBrowserPage(browser);
  page = ui.page;
});
afterEach(async () => {
  try {
    await ui.close();
  } finally {
    await app.close();
  }
});
const secretSwitch = () => secretRow(page, stripe).getByRole('switch');
const bucketCard = () =>
  page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('switch', { name: /Ask first/ }) });
async function openVault(bucket = 'work/acme') {
  await page.goto(`${app.origin}/vault?bucket=${encodeURIComponent(bucket)}`);
  await page.getByRole('heading', { name: bucket, exact: true }).waitFor();
}
async function marks() {
  const response = await fetch(`${app.origin}/api/ask-first`);
  expect(response.status).toBe(200);
  return (await response.json()) as {
    marks: { kind: string; path: string; exists: boolean }[];
  };
}

async function holdWriteAndCountMarks(url: string, method: string) {
  const started = deferred();
  const release = deferred();
  const reads: boolean[] = [];
  let committed = false;
  page.on('request', (request) => {
    if (new URL(request.url()).pathname === '/api/ask-first')
      reads.push(committed);
  });
  await page.route(url, async (route) => {
    if (route.request().method() !== method) return route.continue();
    started.resolve();
    await release.promise;
    const response = await route.fetch();
    committed = response.ok();
    await route.fulfill({ response }).catch(() => {});
  });
  return { started: started.promise, release: release.resolve, reads };
}

it.each(['PUT', 'DELETE'] as const)(
  'E37: a queued toggle reconciles with the server and retains an error when %s fails',
  async (failedMethod) => {
    await openVault();
    const control = secretSwitch();
    await control.waitFor();
    const gate = deferred();
    const started = deferred();
    const writes: string[] = [];
    await page.route(
      `**/api/ask-first/secret/${encodeURIComponent(stripe)}`,
      async (route) => {
        const method = route.request().method();
        writes.push(method);
        if (method === 'PUT') {
          started.resolve();
          await gate.promise;
        }
        if (method === failedMethod)
          await route
            .fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
            .catch(() => {});
        else await route.continue().catch(() => {});
      },
    );
    try {
      await control.click();
      await started.promise;
      await expect
        .poll(() => control.getAttribute('aria-checked'))
        .toBe('true');
      await control.click();
      await expect
        .poll(() => control.getAttribute('aria-checked'))
        .toBe('false');
      expect(writes, 'The second intent waits for the first write').toEqual([
        'PUT',
      ]);
      const reconciled = page.waitForResponse(
        (r) => new URL(r.url()).pathname === '/api/ask-first',
      );
      gate.resolve();
      await (await reconciled).finished();
      await expect.poll(() => writes).toEqual(['PUT', 'DELETE']);
      const serverOn = failedMethod === 'DELETE';
      await expect
        .poll(() => control.getAttribute('aria-checked'))
        .toBe(String(serverOn));
      expect((await marks()).marks.some((m) => m.path === stripe)).toBe(
        serverOn,
      );
      await page
        .getByRole('alert')
        .filter({ hasText: 'Couldn’t change Ask first' })
        .waitFor();
      expect(await control.isEnabled()).toBe(true);
    } finally {
      gate.resolve();
    }
  },
);

it('E37: secret rows and the opened bucket card have Ask first switches, while marked tree rows have only hand icons', async () => {
  await setMark(app, 'work/acme/prod');
  await openVault();
  await expect
    .poll(() => secretSwitch().count(), {
      message: 'Each secret row exposes its Ask first switch',
    })
    .toBe(1);
  expect(await secretSwitch().getAttribute('aria-checked')).toBe('false');
  expect(await secretSwitch().isEnabled()).toBe(true);
  const card = bucketCard();
  expect(await card.count()).toBe(1);
  expect(await card.innerText()).toContain('Ask first');
  expect(await card.getByRole('switch').getAttribute('aria-checked')).toBe(
    'false',
  );
  const tree = page.getByRole('navigation', { name: 'Buckets', exact: true });
  expect(await tree.getByRole('switch').count()).toBe(0);
  const marked = tree.locator('[data-path="work/acme/prod"]');
  expect(await marked.locator('svg.lucide-hand').count()).toBe(1);
  expect(
    await tree
      .locator('[data-path="work/acme"]')
      .locator('svg.lucide-hand')
      .count(),
  ).toBe(0);
  for (const row of await page.locator('[data-secret]').all())
    expect(await row.getByRole('switch').count()).toBe(1);
});

it('E37: inherited marks turn secret and bucket switches on and disable them, with the covering path and hand icons', async () => {
  await setMark(app);
  await openVault();
  await expect
    .poll(() => secretSwitch().count(), {
      message: 'Inherited Ask first is shown on each covered secret',
    })
    .toBe(1);
  expect(await secretSwitch().getAttribute('aria-checked')).toBe('true');
  expect(await secretSwitch().isDisabled()).toBe(true);
  expect(await secretRow(page, stripe).innerText()).toContain(
    'Ask first, from work',
  );
  const card = bucketCard();
  expect(await card.innerText()).toContain(
    'On because work asks first. To turn it off, open that bucket.',
  );
  expect(await card.getByRole('switch').isDisabled()).toBe(true);
  expect(await card.getByRole('switch').getAttribute('aria-checked')).toBe(
    'true',
  );
  const tree = page.getByRole('navigation', { name: 'Buckets', exact: true });
  for (const path of ['work', 'work/acme', 'work/acme/prod'])
    expect(
      await tree.locator(`[data-path="${path}"] svg.lucide-hand`).count(),
    ).toBe(1);
  expect(await tree.getByRole('switch').count()).toBe(0);
  await page.getByRole('link', { name: 'Memory', exact: true }).click();
  expect(
    await page
      .getByRole('navigation', { name: 'Memory buckets' })
      .locator('svg.lucide-hand')
      .count(),
  ).toBe(0);
});

// The toggle does not depend on the kind; the bucket card's switch is the
// covered-secret case below.
it('E37: a secret mark flips optimistically before PUT resolves and reconciles on success and failed 503', async () => {
  await openVault();
  const control = secretSwitch();
  await expect
    .poll(() => control.count(), {
      message: 'The secret Ask first switch is available',
    })
    .toBe(1);
  const gate = deferred();
  const started = deferred();
  const path = stripe;
  const url = `**/api/ask-first/secret/${encodeURIComponent(path)}`;
  await page.route(url, async (route) => {
    started.resolve();
    await gate.promise;
    await route.continue().catch(() => {});
  });
  try {
    await control.click();
    await started.promise;
    await expect
      .poll(() => control.getAttribute('aria-checked'), {
        message: 'The switch flips before the PUT response',
      })
      .toBe('true');
    expect((await marks()).marks).toEqual([]);
    gate.resolve();
    await expect
      .poll(async () => (await marks()).marks.some((m) => m.path === path))
      .toBe(true);
    expect(await control.getAttribute('aria-checked')).toBe('true');
    await page.unroute(url);
    await control.click();
    await expect.poll(async () => (await marks()).marks.length).toBe(0);
    const failed = deferred();
    const failedStarted = deferred();
    await page.route(url, async (route) => {
      failedStarted.resolve();
      await failed.promise;
      await route
        .fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        .catch(() => {});
    });
    try {
      await control.click();
      await failedStarted.promise;
      await expect
        .poll(() => control.getAttribute('aria-checked'))
        .toBe('true');
      failed.resolve();
      await expect
        .poll(() => control.getAttribute('aria-checked'))
        .toBe('false');
      await page
        .getByRole('alert')
        .filter({ hasText: 'Couldn’t change Ask first' })
        .waitFor();
      expect((await marks()).marks).toEqual([]);
    } finally {
      failed.resolve();
    }
  } finally {
    gate.resolve();
  }
});

it('E37: long inherited bucket paths wrap only at / on a 390×844 phone', async () => {
  const parent = 'work/municipal-water-authority-ops-mx/infrastructure';
  const child = `${parent}/terraform-state-backups`;
  await seedGrantTree(app, [parent, child]);
  expect(
    (
      await createSecret(
        app,
        secretInput({ bucket: child, name: 'DATABASE_URL' }),
      )
    ).status,
  ).toBe(201);
  await setMark(app, parent);
  await page.setViewportSize({ width: 390, height: 844 });
  await openVault(child);
  await expect
    .poll(() => page.getByRole('switch').count(), {
      message: 'Long inherited marks render the bucket and secret switches',
    })
    .toBeGreaterThan(0);
  const inherited = page.getByText(
    `On because ${parent} asks first. To turn it off, open that bucket.`,
    { exact: true },
  );
  expect(await inherited.count()).toBe(1);
  const paths = inherited.getByText(parent, { exact: true });
  expect(
    (await expectSlashBreaks(paths)).length,
    'The inherited path actually wraps',
  ).toBeGreaterThan(0);
  await expectSlashBreaks(
    page.getByRole('heading', { name: child, exact: true }),
  );
  await expectNoOverflow(page);
});

it('E37: rapid toggles stay optimistic, serialize writes per path and preserve the latest intent across a stale list response', async () => {
  await openVault();
  const control = secretSwitch();
  await expect
    .poll(() => control.count(), {
      message: 'The secret Ask first switch supports consecutive intents',
    })
    .toBe(1);
  // Retain a genuine pre-write list and release it while PUT is still held.
  const readGate = deferred();
  const readStarted = deferred();
  await page.route('**/api/ask-first', async (route) => {
    const response = await route.fetch();
    readStarted.resolve();
    await readGate.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  const putGate = deferred();
  const writeStarted = deferred();
  const writes: string[] = [];
  await page.route(
    `**/api/ask-first/secret/${encodeURIComponent(stripe)}`,
    async (route) => {
      writes.push(route.request().method());
      writeStarted.resolve();
      if (route.request().method() === 'PUT') await putGate.promise;
      await route.continue().catch(() => {});
    },
  );
  try {
    // A normal route remount refreshes the list, without an invented product API.
    await page.clock.setFixedTime(new Date(approvalNow.getTime() + 31_000));
    await page.getByRole('link', { name: 'Memory', exact: true }).click();
    // A click can finish while the lazy Memory page still leaves Vault mounted.
    await page
      .getByRole('navigation', { name: 'Memory buckets', exact: true })
      .waitFor();
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await readStarted.promise;
    await page.locator('[data-path="work/acme"] a').click();
    await control.click();
    await writeStarted.promise;
    await expect.poll(() => control.getAttribute('aria-checked')).toBe('true');
    const refreshed = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ask-first',
    );
    readGate.resolve();
    await (await refreshed).finished();
    await page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(
      await control.getAttribute('aria-checked'),
      'An older server list cannot erase pending intent',
    ).toBe('true');
    await control.click();
    await expect.poll(() => control.getAttribute('aria-checked')).toBe('false');
    expect(writes, 'DELETE waits for this path’s PUT').toEqual(['PUT']);
    const reconciled = page.waitForResponse(
      (r) => new URL(r.url()).pathname === '/api/ask-first',
    );
    putGate.resolve();
    await expect.poll(() => writes).toEqual(['PUT', 'DELETE']);
    await (await reconciled).finished();
    await expect.poll(async () => (await marks()).marks.length).toBe(0);
    expect(await control.getAttribute('aria-checked')).toBe('false');
  } finally {
    readGate.resolve();
    putGate.resolve();
  }
});

it('E38: a bucket recreation cancels an older inactive marks preload', async () => {
  const path = 'work/old-client';
  expect((await jsonRequest(app, '/api/buckets', { path })).ok).toBe(true);
  await setMark(app, path);
  expect(
    (
      await jsonRequest(
        app,
        `/api/buckets/${encodeURIComponent(path)}`,
        undefined,
        {},
        'DELETE',
      )
    ).status,
  ).toBe(204);
  await page.goto(`${app.origin}/buckets`);
  const field = page.getByRole('textbox', { name: 'New bucket path' });
  await field.waitFor();
  const old = deferred();
  const read = deferred();
  let held = false;
  await page.route('**/api/ask-first', async (route) => {
    if (held) return route.continue();
    held = true;
    const response = await route.fetch();
    expect(await response.json()).toMatchObject({
      marks: [{ kind: 'bucket', path, exists: false }],
    });
    read.resolve();
    await old.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole('link', { name: 'Vault', exact: true }).hover();
    await read.promise;
    await field.fill(path);
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === 'POST' &&
        new URL(r.url()).pathname === '/api/buckets',
    );
    await field.press('Enter');
    expect((await saved).ok()).toBe(true);
    await page
      .getByRole('button', { name: `Actions for ${path}`, exact: true })
      .waitFor();
    old.resolve();
    await page.waitForLoadState('networkidle');
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await page.locator(`[data-path="${path}"] a`).click();
    await expect
      .poll(() => bucketCard().getByRole('switch').getAttribute('aria-checked'))
      .toBe('true');
    await expect
      .poll(
        () =>
          page
            .getByRole('alert')
            .filter({ hasText: 'Ask first is on a deleted bucket' })
            .count(),
        {
          message:
            'A pre-write preload cannot restore an orphan alert after recreation',
        },
      )
      .toBe(0);
  } finally {
    old.resolve();
  }
});

it('E38: a changed bucket read refreshes cached orphan warnings without an Ask-first-specific write callback', async () => {
  const path = 'work/old-client';
  expect((await jsonRequest(app, '/api/buckets', { path })).ok).toBe(true);
  await setMark(app, path);
  await openVault();
  await page.getByRole('switch').first().waitFor();
  const orphan = page
    .getByRole('alert')
    .filter({ hasText: 'Ask first is on a deleted bucket' });
  expect(await orphan.count()).toBe(0);
  await page
    .locator('[data-sidebar="menu-button"]')
    .filter({ hasText: /^Buckets$/ })
    .click();
  await page.getByRole('textbox', { name: 'New bucket path' }).waitFor();
  // A different client removes the bucket. Only a normal bucket read in this
  // browser learns that it changed; no local write callback runs at all.
  expect(
    (
      await jsonRequest(
        app,
        `/api/buckets/${encodeURIComponent(path)}`,
        undefined,
        {},
        'DELETE',
      )
    ).status,
  ).toBe(204);
  const refreshed = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/buckets',
  );
  await page.evaluate(() =>
    window.dispatchEvent(new Event('visibilitychange')),
  );
  expect((await refreshed).status()).toBe(200);
  await expect
    .poll(() =>
      page.getByRole('button', { name: `Actions for ${path}` }).count(),
    )
    .toBe(0);
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await expect.poll(() => orphan.count()).toBe(1);
  expect(await page.evaluate(() => Date.now())).toBe(approvalNow.getTime());
});

it.each(['create', 'delete'] as const)(
  'E38: a bucket %s updates orphan marks before the cached list becomes stale',
  async (operation) => {
    const path = 'work/old-client';
    expect((await jsonRequest(app, '/api/buckets', { path })).ok).toBe(true);
    await setMark(app, path);
    if (operation === 'create')
      expect(
        (
          await jsonRequest(
            app,
            `/api/buckets/${encodeURIComponent(path)}`,
            undefined,
            {},
            'DELETE',
          )
        ).status,
      ).toBe(204);
    await openVault();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Ask first is on a deleted bucket' });
    await expect
      .poll(() => page.getByRole('switch').count())
      .toBeGreaterThan(0);
    expect(await alert.count()).toBe(operation === 'create' ? 1 : 0);
    await page
      .locator('[data-sidebar="menu-button"]')
      .filter({ hasText: /^Buckets$/ })
      .click();
    await page.getByRole('textbox', { name: 'New bucket path' }).waitFor();
    await page.waitForLoadState('networkidle');
    const method = operation === 'create' ? 'POST' : 'DELETE';
    const endpoint =
      operation === 'create'
        ? '/api/buckets'
        : `/api/buckets/${encodeURIComponent(path)}`;
    const write = await holdWriteAndCountMarks(`**${endpoint}`, method);
    try {
      if (operation === 'create') {
        const field = page.getByRole('textbox', { name: 'New bucket path' });
        await field.fill(path);
        await field.press('Enter');
      } else {
        await page
          .getByRole('button', { name: `Actions for ${path}`, exact: true })
          .click();
        await page
          .getByRole('menuitem', { name: 'Delete bucket…', exact: true })
          .click();
        await page
          .getByRole('button', { name: 'Delete bucket', exact: true })
          .click();
      }
      await write.started;
      // Remount Vault while the optimistic bucket list is still uncommitted.
      await page.getByRole('link', { name: 'Vault', exact: true }).click();
      await page.locator('[data-path="work/acme"] a').click();
      await secretSwitch().waitFor();
      expect
        .soft(write.reads, 'No marks read before the bucket commits')
        .toEqual([]);
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === method &&
          new URL(r.url()).pathname === endpoint,
      );
      write.release();
      expect((await saved).status()).toBe(operation === 'create' ? 200 : 204);
      await expect.poll(() => write.reads.some(Boolean)).toBe(true);
      await page.waitForLoadState('networkidle');
      expect(
        write.reads,
        'Exactly one marks read, after the bucket commits',
      ).toEqual([true]);
    } finally {
      write.release();
    }
    expect((await marks()).marks).toContainEqual({
      kind: 'bucket',
      path,
      exists: operation === 'create',
    });
    expect(await page.evaluate(() => Date.now())).toBe(approvalNow.getTime());
    if (operation === 'create') {
      await page.locator(`[data-path="${path}"] a`).click();
      const control = bucketCard().getByRole('switch');
      expect(await control.getAttribute('aria-checked')).toBe('true');
    }
    await expect
      .poll(() => alert.count(), {
        message:
          'Orphan alerts follow the completed bucket write within the 30-second cache window',
      })
      .toBe(operation === 'delete' ? 1 : 0);
  },
);

it.each(['create', 'delete'] as const)(
  'E38: a secret %s updates orphan marks before the cached list becomes stale',
  async (operation) => {
    await setMark(app, stripe, 'secret');
    if (operation === 'create') {
      const secret = (await listSecrets(app)).find(
        (secret) => secret.path === stripe,
      );
      if (!secret) throw new Error('The marked synthetic secret must exist.');
      expect((await deleteSecret(app, stripe, secret.version)).status).toBe(
        204,
      );
    }
    await openVault();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Ask first is on a deleted secret' });
    await expect
      .poll(() => page.getByRole('switch').count())
      .toBeGreaterThan(0);
    expect(await alert.count()).toBe(operation === 'create' ? 1 : 0);
    await page.waitForLoadState('networkidle');
    const method = operation === 'create' ? 'POST' : 'DELETE';
    const endpoint =
      operation === 'create'
        ? '/api/secrets'
        : `/api/secrets/${encodeURIComponent(stripe)}`;
    const write = await holdWriteAndCountMarks(`**${endpoint}*`, method);
    try {
      if (operation === 'create') {
        const sheet = await createDraft(page, { name: 'STRIPE_KEY' });
        await sheet
          .getByRole('button', { name: 'Save secret', exact: true })
          .click();
      } else {
        await openSecretMenu(page, stripe, 'Delete secret…');
        await page
          .getByRole('button', { name: 'Delete secret', exact: true })
          .click();
      }
      await write.started;
      expect(write.reads, 'No marks read before the secret commits').toEqual(
        [],
      );
      const saved = page.waitForResponse(
        (r) =>
          r.request().method() === method &&
          new URL(r.url()).pathname === endpoint,
      );
      write.release();
      expect((await saved).status()).toBe(operation === 'create' ? 201 : 204);
      await expect.poll(() => write.reads.some(Boolean)).toBe(true);
      await page.waitForLoadState('networkidle');
      expect(
        write.reads,
        'Exactly one marks read, after the secret commits',
      ).toEqual([true]);
    } finally {
      write.release();
    }
    expect((await marks()).marks).toContainEqual({
      kind: 'secret',
      path: stripe,
      exists: operation === 'create',
    });
    expect(await page.evaluate(() => Date.now())).toBe(approvalNow.getTime());
    await expect
      .poll(() => alert.count(), {
        message:
          'Orphan alerts follow the completed secret write within the 30-second cache window',
      })
      .toBe(operation === 'delete' ? 1 : 0);
    if (operation === 'create')
      expect(await secretSwitch().getAttribute('aria-checked')).toBe('true');
  },
);

it('E38: a deleted bucket mark appears above Vault with Remove mark and disappears optimistically', async () => {
  await seedGrantTree(app, ['work/old-client']);
  await setMark(app, 'work/old-client');
  const removed = await fetch(
    `${app.origin}/api/buckets/${encodeURIComponent('work/old-client')}`,
    { method: 'DELETE' },
  );
  expect(removed.status).toBe(204);
  expect((await marks()).marks).toContainEqual({
    kind: 'bucket',
    path: 'work/old-client',
    exists: false,
  });
  await openVault();
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Ask first is on a deleted bucket' });
  await expect
    .poll(() => alert.count(), {
      message: 'The orphan mark appears in the Vault alert',
    })
    .toBe(1);
  expect(await alert.innerText()).toContain(
    'work/old-client no longer exists. Its mark still applies if an agent creates it again.',
  );
  const alertBox = await alert.boundingBox();
  const secretBox = await secretRow(page, stripe).boundingBox();
  if (!alertBox || !secretBox)
    throw new Error('The orphan alert and secret row must be visible.');
  expect(alertBox.y).toBeLessThan(secretBox.y);
  const gate = deferred();
  const started = deferred();
  await page.route(
    '**/api/ask-first/bucket/work%2Fold-client',
    async (route) => {
      started.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    },
  );
  try {
    await alert
      .getByRole('button', { name: 'Remove mark', exact: true })
      .click();
    await started.promise;
    await expect.poll(() => alert.count()).toBe(0);
    expect((await marks()).marks).toHaveLength(1);
    gate.resolve();
    await expect.poll(async () => (await marks()).marks.length).toBe(0);
  } finally {
    gate.resolve();
  }
});

it('E37: an optimistic bucket mark covers an already marked secret and failed PUT restores its explicit switch', async () => {
  await setMark(app, stripe, 'secret');
  await openVault();
  const control = secretSwitch();
  await expect.poll(() => control.count()).toBe(1);
  expect(await control.getAttribute('aria-checked')).toBe('true');
  expect(await control.isEnabled()).toBe(true);
  const gate = deferred();
  const started = deferred();
  await page.route('**/api/ask-first/bucket/work%2Facme', async (route) => {
    started.resolve();
    await gate.promise;
    await route
      .fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
      .catch(() => {});
  });
  try {
    const bucketSwitch = bucketCard().getByRole('switch');
    await bucketSwitch.click();
    await started.promise;
    await expect.poll(() => control.isDisabled()).toBe(true);
    expect(await bucketSwitch.getAttribute('aria-checked')).toBe('true');
    expect(await secretRow(page, stripe).innerText()).toContain(
      'Ask first, from work/acme',
    );
    gate.resolve();
    await expect.poll(() => control.isEnabled()).toBe(true);
    expect(await bucketSwitch.getAttribute('aria-checked')).toBe('false');
    expect(await control.getAttribute('aria-checked')).toBe('true');
    expect(await secretRow(page, stripe).innerText()).toContain(
      'Ask first, on this secret',
    );
  } finally {
    gate.resolve();
  }
});

it('E37: Vault intent preloads marks without adding a read when the page opens', async () => {
  await setMark(app);
  const reads: string[] = [];
  page.on('request', (request) => {
    if (
      request.method() === 'GET' &&
      new URL(request.url()).pathname === '/api/ask-first'
    )
      reads.push(request.url());
  });
  await page.goto(app.origin);
  await page
    .getByRole('region', { name: 'Owner access', exact: true })
    .waitFor();
  expect(reads).toEqual([]);
  const loaded = page.waitForResponse(
    (response) => new URL(response.url()).pathname === '/api/ask-first',
  );
  await page.getByRole('link', { name: 'Vault', exact: true }).hover();
  expect((await loaded).status()).toBe(200);
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.locator('[data-path="work/acme"] a').click();
  await expect.poll(() => secretSwitch().isDisabled()).toBe(true);
  expect(await secretSwitch().getAttribute('aria-checked')).toBe('true');
  expect(reads).toHaveLength(1);
});

it('E37: stale Vault intent reuses one marks read when bucket and secret data are unchanged', async () => {
  await setMark(app);
  await openVault();
  await secretSwitch().waitFor();
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Memory', exact: true }).click();
  await page.getByRole('navigation', { name: 'Memory buckets' }).waitFor();
  await page.clock.setFixedTime(new Date(approvalNow.getTime() + 31_000));
  const reads: string[] = [];
  page.on('request', (r) => {
    if (new URL(r.url()).pathname === '/api/ask-first') reads.push(r.url());
  });
  const loaded = page.waitForResponse(
    (r) => new URL(r.url()).pathname === '/api/ask-first',
  );
  await page.getByRole('link', { name: 'Vault', exact: true }).hover();
  await loaded;
  await page.waitForLoadState('networkidle');
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.locator('[data-path="work/acme"] a').click();
  await secretSwitch().waitFor();
  await page.waitForLoadState('networkidle');
  expect(reads).toHaveLength(1);
  expect(await secretSwitch().getAttribute('aria-checked')).toBe('true');
});

it('E37: Vault intent starts marks and secrets together before lazy controls have downloaded', async () => {
  await page.goto(app.origin);
  await page
    .getByRole('region', { name: 'Owner access', exact: true })
    .waitFor();
  await page.waitForLoadState('networkidle');
  const gate = deferred();
  const reads: string[] = [];
  page.on('request', (r) => {
    if (['/api/ask-first', '/api/secrets'].includes(new URL(r.url()).pathname))
      reads.push(new URL(r.url()).pathname);
  });
  await page.route('**/*.js', async (route) => {
    await gate.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.getByRole('link', { name: 'Vault', exact: true }).hover();
    await expect
      .poll(() => reads, {
        message: 'Marks preload must not wait for the lazy controls module',
      })
      .toContain('/api/ask-first');
    expect(reads).toContain('/api/secrets');
  } finally {
    gate.resolve();
    await page.waitForLoadState('networkidle');
  }
});

it('E38: importing a recreated marked secret clears its cached orphan alert', async () => {
  await setMark(app, stripe, 'secret');
  const secret = (await listSecrets(app)).find(
    (entry) => entry.path === stripe,
  );
  if (!secret) throw new Error('Missing synthetic secret');
  expect((await deleteSecret(app, stripe, secret.version)).status).toBe(204);
  await openVault();
  const orphan = page
    .getByRole('alert')
    .filter({ hasText: 'Ask first is on a deleted secret' });
  await orphan.waitFor();
  await reviewPaste(page, 'STRIPE_KEY=synthetic-imported-value');
  await createImport(page, 1);
  await importSettled(page);
  await importSheet(page)
    .getByRole('button', { name: 'Done', exact: true })
    .click();
  await secretRow(page, stripe).waitFor();
  await expect.poll(() => orphan.count()).toBe(0);
  expect(await secretSwitch().getAttribute('aria-checked')).toBe('true');
});
