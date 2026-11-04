import type { Browser, Page } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
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
import { createSecret, secretInput } from './support/vault.ts';
import { secretRow } from './support/vault-browser.ts';

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
  const writes: string[] = [];
  page.on('request', (r) => {
    if (['PUT', 'DELETE'].includes(r.method())) writes.push(r.url());
  });
  await secretSwitch().focus();
  await page.keyboard.press('Space');
  expect(writes, 'An inherited switch cannot write a child override').toEqual(
    [],
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

it.each(['secret', 'bucket'] as const)(
  'E37: a %s mark flips optimistically before PUT resolves and reconciles on success and failed 503',
  async (kind) => {
    await openVault();
    const control =
      kind === 'secret' ? secretSwitch() : bucketCard().getByRole('switch');
    await expect
      .poll(() => control.count(), {
        message: `The ${kind} Ask first switch is available`,
      })
      .toBe(1);
    const gate = deferred();
    const started = deferred();
    const path = kind === 'secret' ? stripe : 'work/acme';
    const url = `**/api/ask-first/${kind}/${encodeURIComponent(path)}`;
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
        await page.getByRole('alert').waitFor();
        expect(
          (await page.getByRole('alert').innerText()).length,
        ).toBeGreaterThan(0);
        expect((await marks()).marks).toEqual([]);
      } finally {
        failed.resolve();
      }
    } finally {
      gate.resolve();
    }
  },
);

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
    putGate.resolve();
    await expect.poll(() => writes).toEqual(['PUT', 'DELETE']);
    await expect.poll(async () => (await marks()).marks.length).toBe(0);
    expect(await control.getAttribute('aria-checked')).toBe('false');
  } finally {
    readGate.resolve();
    putGate.resolve();
  }
});

it('E37: a failed DELETE restores the server mark and an error instead of leaving Ask first off', async () => {
  await setMark(app, stripe, 'secret');
  await openVault();
  const control = secretSwitch();
  await expect
    .poll(() => control.count(), {
      message: 'An explicit secret mark can be switched off',
    })
    .toBe(1);
  const gate = deferred();
  const started = deferred();
  await page.route(
    `**/api/ask-first/secret/${encodeURIComponent(stripe)}`,
    async (route) => {
      expect(route.request().method()).toBe('DELETE');
      started.resolve();
      await gate.promise;
      await route
        .fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        .catch(() => {});
    },
  );
  try {
    await control.click();
    await started.promise;
    await expect.poll(() => control.getAttribute('aria-checked')).toBe('false');
    expect((await marks()).marks).toContainEqual({
      kind: 'secret',
      path: stripe,
      exists: true,
    });
    gate.resolve();
    await expect.poll(() => control.getAttribute('aria-checked')).toBe('true');
    await page.getByRole('alert').waitFor();
    expect((await page.getByRole('alert').innerText()).length).toBeGreaterThan(
      0,
    );
  } finally {
    gate.resolve();
  }
});

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

it('E38: a failed Remove mark restores the orphan alert and reports an error', async () => {
  await seedGrantTree(app, ['work/old-client']);
  await setMark(app, 'work/old-client');
  expect(
    (
      await fetch(
        `${app.origin}/api/buckets/${encodeURIComponent('work/old-client')}`,
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(204);
  await openVault();
  const alert = page
    .getByRole('alert')
    .filter({ hasText: 'Ask first is on a deleted bucket' });
  await expect
    .poll(() => alert.count(), {
      message: 'The orphan alert offers Remove mark',
    })
    .toBe(1);
  const gate = deferred();
  const started = deferred();
  await page.route(
    '**/api/ask-first/bucket/work%2Fold-client',
    async (route) => {
      started.resolve();
      await gate.promise;
      await route
        .fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        .catch(() => {});
    },
  );
  try {
    await alert
      .getByRole('button', { name: 'Remove mark', exact: true })
      .click();
    await started.promise;
    await expect.poll(() => alert.count()).toBe(0);
    gate.resolve();
    await expect.poll(() => alert.count()).toBe(1);
    expect((await marks()).marks).toContainEqual({
      kind: 'bucket',
      path: 'work/old-client',
      exists: false,
    });
    expect(await page.getByRole('alert').count()).toBeGreaterThan(1);
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
    await bucketCard().getByRole('switch').click();
    await started.promise;
    await expect.poll(() => control.isDisabled()).toBe(true);
    expect(await secretRow(page, stripe).innerText()).toContain(
      'Ask first, from work/acme',
    );
    gate.resolve();
    await expect.poll(() => control.isEnabled()).toBe(true);
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
