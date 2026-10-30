import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  existingNames,
  importBucket,
  importedValues,
  keysPaste,
  mixedPaste,
  mixedValues,
  readyNames,
} from './fixtures/vault-import.ts';
import { auditRows } from './support/audit.ts';
import { observeBrowserPage } from './support/buckets-browser.ts';
import { revealSecret } from './support/reveal.ts';
import {
  createSecret,
  listSecrets,
  secretInput,
  secretRows,
} from './support/vault.ts';
import { privateClientState, secretRow } from './support/vault-browser.ts';
import {
  chooseImportBucket,
  createImport,
  expectCreated,
  expectDomPrivate,
  expectOutcome,
  expectStoredValues,
  expectWriteIds,
  failImportKey,
  holdImportCreates,
  importPage,
  importSettled,
  importSheet,
  observeImportConsole,
  openImport,
  pasteField,
  restoreImportStorage,
  reviewPaste,
  reviewRow,
  runRow,
  shortFailure,
} from './support/vault-import-browser.ts';
import {
  loseImportResponses,
  lostName,
  lostValue,
  otherValue,
} from './support/vault-import-loss.ts';
import { partialImportResults } from './support/vault-import-partial.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

async function expectMixedReview(page: Page) {
  const ready = importSheet(page).getByRole('checkbox', { name: /^Include / });
  expect(await ready.count()).toBe(8);
  for (const name of readyNames)
    expect(
      await importSheet(page)
        .getByRole('checkbox', { name: `Include ${name}`, exact: true })
        .isChecked(),
    ).toBe(true);
  for (const line of [6, 8])
    expect(await reviewRow(page, line).innerText()).toContain(
      'Already in work/acme/api.',
    );
  for (const line of [10, 11])
    expect(await reviewRow(page, line).innerText()).toContain('Invalid name.');
  expect(await reviewRow(page, 12).innerText()).toContain(
    'Empty value. Skipped.',
  );
  expect(
    await importSheet(page)
      .getByRole('textbox', { name: /^Name from line / })
      .count(),
  ).toBe(13);
  await importSheet(page)
    .getByText(/Line 17 isn’t a KEY=value line/)
    .waitFor();
  expect(await importSheet(page).innerText()).not.toContain(
    'paste the slack token here later',
  );
  expect(
    await importSheet(page)
      .getByRole('button', { name: 'Create 8 secrets', exact: true })
      .isEnabled(),
  ).toBe(true);
}

it('E1/E9: mixed creates eight distinct writes with at most three in flight and one final list read', async () => {
  const visit = await importPage(browser);
  const { page, app, traffic } = visit;
  const pool = await holdImportCreates(page);
  try {
    await reviewPaste(page);
    await expectMixedReview(page);
    await importSheet(page)
      .getByRole('textbox', {
        name: 'Description for DATABASE_URL',
        exact: true,
      })
      .fill('Local development database');
    const before = await secretRows(app);
    const reads = traffic.listReads();
    await createImport(page, 8);
    await expect.poll(() => pool.held.length).toBe(3);
    expect(pool.active()).toBe(3);
    expect(traffic.listReads()).toBe(reads);
    for (const { input } of pool.held)
      expect(
        await secretRow(page, `${importBucket}/${input.name}`).innerText(),
      ).toContain('Saving');
    pool.held[0].gate.resolve();
    await expect.poll(() => pool.held.length).toBe(4);
    expect(pool.peak()).toBe(3);
    expect(traffic.listReads()).toBe(reads);
    expect(
      await page
        .getByRole('alert', { includeHidden: true })
        .filter({ hasText: 'Secret saved' })
        .count(),
    ).toBe(0);
    pool.releaseAll();
    await importSettled(page);
    await expectCreated(page, readyNames);
    expect(traffic.posts).toHaveLength(8);
    expect(traffic.posts.map(({ name }) => name).sort()).toEqual(
      [...readyNames].sort(),
    );
    expectWriteIds(traffic.posts, 8);
    expect(pool.peak()).toBeLessThanOrEqual(3);
    expect(traffic.listReads() - reads).toBe(1);
    expect(
      (await listSecrets(app)).filter(({ bucket }) => bucket === importBucket),
    ).toHaveLength(10);
    expect(
      await page
        .getByRole('region', { name: 'Stored here', includeHidden: true })
        .locator('[data-secret]')
        .count(),
    ).toBe(10);
    expect(
      traffic.posts.find(({ name }) => name === 'DATABASE_URL')?.description,
    ).toBe('Local development database');
    expect(
      (await listSecrets(app)).find(
        ({ bucket, name }) =>
          bucket === importBucket && name === 'DATABASE_URL',
      )?.description,
    ).toBe('Local development database');
    expect(
      (await secretRows(app)).filter(
        ({ name, bucket }) =>
          bucket === importBucket && existingNames.includes(name),
      ),
    ).toEqual(
      before.filter(
        ({ name, bucket }) =>
          bucket === importBucket && existingNames.includes(name),
      ),
    );
    await expectStoredValues(
      visit,
      Object.fromEntries(readyNames.map((name) => [name, mixedValues[name]])),
    );
    await expectStoredValues(visit, {
      SENTRY_DSN: visit.values[3],
      STRIPE_SECRET_KEY: visit.values[4],
    });
  } finally {
    pool.releaseAll();
    await visit.close();
  }
});

it('E6: changing the review bucket to me recomputes statuses and says Create 9 secrets', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  try {
    await reviewPaste(page);
    await chooseImportBucket(page, 'me');
    expect(await reviewRow(page, 9).innerText()).toContain('Already in me.');
    for (const name of existingNames)
      expect(
        await importSheet(page)
          .getByRole('checkbox', { name: `Include ${name}`, exact: true })
          .isChecked(),
      ).toBe(true);
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Create 9 secrets', exact: true })
        .isEnabled(),
    ).toBe(true);
    expect(visit.traffic.writes()).toEqual([]);
  } finally {
    await visit.close();
  }
});

it('E5: an overlong description blocks only its row with the contract message and never leaves the browser', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  try {
    await reviewPaste(
      page,
      'GOOD_KEY=synthetic-good-description\nLONG_DESCRIPTION=synthetic-blocked-description',
    );
    const description = importSheet(page).getByRole('textbox', {
      name: 'Description for LONG_DESCRIPTION',
      exact: true,
    });
    expect(await description.inputValue()).toBe('');
    // Exercise the validation even when the input also has an HTML length guard.
    await description.evaluate((field) => field.removeAttribute('maxlength'));
    await description.fill('😀'.repeat(201));
    await reviewRow(page, 2)
      .getByText('A description can have at most 200 characters.', {
        exact: true,
      })
      .waitFor();
    expect(visit.traffic.writes()).toEqual([]);
    await createImport(page, 1);
    await importSettled(page);
    await expectOutcome(page, 'GOOD_KEY', 'Created');
    expect(visit.traffic.posts.map(({ name }) => name)).toEqual(['GOOD_KEY']);
    expect(
      visit.traffic.requests.every(
        ({ body }) => !body?.includes('synthetic-blocked-description'),
      ),
    ).toBe(true);
  } finally {
    await visit.close();
  }
});

it('E5: a valid description of 200 Unicode characters reaches storage without native truncation', async () => {
  const visit = await importPage(browser);
  const description = '😀'.repeat(200);
  try {
    await reviewPaste(
      visit.page,
      'UNICODE_DESCRIPTION=synthetic-unicode-description',
    );
    const field = importSheet(visit.page).getByRole('textbox', {
      name: 'Description for UNICODE_DESCRIPTION',
      exact: true,
    });
    await field.fill(description);
    expect(await field.inputValue()).toBe(description);
    await createImport(visit.page, 1);
    await importSettled(visit.page);
    await expectOutcome(visit.page, 'UNICODE_DESCRIPTION', 'Created');
    expect(visit.traffic.posts[0].description).toBe(description);
    expect(
      (await listSecrets(visit.app)).find(
        (secret) => secret.name === 'UNICODE_DESCRIPTION',
      )?.description,
    ).toBe(description);
  } finally {
    await visit.close();
  }
});

it('E7: 101 keys stay on Paste with a count and trim guidance; exactly 100 reach Review without a write', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  try {
    await openImport(page);
    await pasteField(page).fill(keysPaste(101));
    await importSheet(page)
      .getByText(
        'This paste has 101 keys. Nook imports up to 100 at a time, so nothing can be created from it.',
        { exact: true },
      )
      .waitFor();
    await importSheet(page)
      .getByText(
        'Remove some lines, or split the file and import it in parts.',
        { exact: true },
      )
      .waitFor();
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Review keys', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(
      await importSheet(page)
        .getByRole('textbox', { name: /^Name from line / })
        .count(),
    ).toBe(0);
    expect(visit.traffic.writes()).toEqual([]);
    await pasteField(page).fill(keysPaste(100));
    await importSheet(page)
      .getByRole('button', { name: 'Review keys', exact: true })
      .click();
    expect(
      await importSheet(page)
        .getByRole('textbox', { name: /^Name from line / })
        .count(),
    ).toBe(100);
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Create 100 secrets', exact: true })
        .isEnabled(),
    ).toBe(true);
    expect(visit.traffic.writes()).toEqual([]);
  } finally {
    await visit.close();
  }
});

it.each([
  ['empty', ''],
  ['too-long', 'synthetic-too-long-'.repeat(4096)],
])(
  'E3: excluding a blocked %s occurrence through its checkbox makes the valid occurrence Ready',
  async (kind, blockedValue) => {
    const visit = await importPage(browser);
    const { page, traffic } = visit;
    try {
      await reviewPaste(
        page,
        `DATABASE_URL=synthetic-one\nDATABASE_URL=${blockedValue}`,
      );
      const valid = reviewRow(page, 1);
      const blocked = reviewRow(page, 2);
      const reason =
        kind === 'empty'
          ? 'Empty value. Skipped.'
          : 'Value is over 64 KiB. Skipped.';
      expect(await valid.innerText()).toContain('Duplicate.');
      expect(await blocked.innerText()).toContain(reason);
      expect(
        await importSheet(page)
          .getByRole('button', { name: 'Create 0 secrets', exact: true })
          .isEnabled(),
      ).toBe(false);
      expect(traffic.posts).toHaveLength(0);
      const checkbox = blocked.getByRole('checkbox', {
        name: 'Include DATABASE_URL',
        exact: true,
      });
      expect(await checkbox.count()).toBe(1);
      expect(await checkbox.isChecked()).toBe(true);
      await checkbox.uncheck();
      expect(await checkbox.isChecked()).toBe(false);
      expect(await blocked.innerText()).toContain(reason);
      expect(await valid.innerText()).toContain('Ready.');
      expect(
        await importSheet(page)
          .getByRole('button', { name: 'Create 1 secret', exact: true })
          .isEnabled(),
      ).toBe(true);
      await createImport(page, 1);
      await importSettled(page);
      await expectOutcome(page, 'DATABASE_URL', 'Created');
      expect(traffic.posts).toHaveLength(1);
      expect(traffic.posts[0]).toMatchObject({
        bucket: importBucket,
        name: 'DATABASE_URL',
        value: 'synthetic-one',
      });
      await expectStoredValues(visit, { DATABASE_URL: 'synthetic-one' });
    } finally {
      await visit.close();
    }
  },
);

it('E8: unchecking every Ready row disables Create 0 secrets', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  try {
    await reviewPaste(page);
    for (const name of readyNames)
      await importSheet(page)
        .getByRole('checkbox', { name: `Include ${name}`, exact: true })
        .uncheck();
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Create 0 secrets', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(visit.traffic.writes()).toEqual([]);
  } finally {
    await visit.close();
  }
});

it('E10: a concurrent writer wins STRIPE_WEBHOOK_SECRET without overwrite or a retry', async () => {
  let raced = false;
  const other = 'synthetic-import-concurrent-webhook';
  const statuses: number[] = [];
  const visit = await importPage(browser, {
    configure: async (page, app) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        if (route.request().postDataJSON().name !== 'STRIPE_WEBHOOK_SECRET')
          return route.continue();
        expect(raced).toBe(false);
        raced = true;
        expect(
          (
            await createSecret(
              app,
              secretInput({
                bucket: importBucket,
                name: 'STRIPE_WEBHOOK_SECRET',
                value: other,
              }),
            )
          ).status,
        ).toBe(201);
        const response = await route.fetch();
        statuses.push(response.status());
        expect((await response.json())._tag).toBe('SecretExists');
        await route.fulfill({ response });
      });
    },
  });
  try {
    await reviewPaste(visit.page);
    expect(raced).toBe(false);
    await createImport(visit.page, 8);
    await importSettled(visit.page);
    await expectOutcome(visit.page, 'STRIPE_WEBHOOK_SECRET', 'Already exists');
    await expectCreated(
      visit.page,
      readyNames.filter((name) => name !== 'STRIPE_WEBHOOK_SECRET'),
    );
    expect(statuses).toEqual([409]);
    expect(visit.traffic.posts).toHaveLength(8);
    await expectStoredValues(visit, { STRIPE_WEBHOOK_SECRET: other });
  } finally {
    await visit.close();
  }
});

it('E11: one D1 failure ends Failed; Retry failed sends only that key with its original write id', async () => {
  const visit = await importPage(browser, {
    configure: (_page, app) => failImportKey(app, 'STRIPE_WEBHOOK_SECRET'),
  });
  const { page, app, traffic } = visit;
  try {
    await reviewPaste(page);
    await createImport(page, 8);
    await importSettled(page);
    await expectOutcome(page, 'STRIPE_WEBHOOK_SECRET', 'Failed');
    await shortFailure(runRow(page, 'STRIPE_WEBHOOK_SECRET'));
    await expectCreated(
      page,
      readyNames.filter((name) => name !== 'STRIPE_WEBHOOK_SECRET'),
    );
    const before = [...traffic.posts];
    const failures = before.filter(
      ({ name }) => name === 'STRIPE_WEBHOOK_SECRET',
    );
    expect(failures).toHaveLength(3);
    expectWriteIds(failures, 1);
    expect(before).toHaveLength(10);
    await restoreImportStorage(app);
    await importSheet(page)
      .getByRole('button', { name: 'Retry failed', exact: true })
      .click();
    await expectCreated(page, readyNames);
    await importSettled(page);
    expect(
      traffic.posts
        .slice(before.length)
        .map(({ name, writeId }) => ({ name, writeId })),
    ).toEqual([
      { name: 'STRIPE_WEBHOOK_SECRET', writeId: failures[0].writeId },
    ]);
    expect(
      (await listSecrets(app)).filter(({ bucket }) => bucket === importBucket),
    ).toHaveLength(10);
    await expectStoredValues(visit, {
      STRIPE_WEBHOOK_SECRET: mixedValues.STRIPE_WEBHOOK_SECRET,
    });
  } finally {
    await visit.close();
  }
});

it('E11/state space: a D1 failure before commit succeeds on the automatic retry with the same id', async () => {
  const statuses: number[] = [];
  const visit = await importPage(browser, {
    configure: async (page, app) => {
      await failImportKey(app, 'TRANSIENT_KEY');
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        statuses.push(response.status());
        if (statuses.length === 1) await restoreImportStorage(app);
        await route.fulfill({ response });
      });
    },
  });
  try {
    await reviewPaste(visit.page, 'TRANSIENT_KEY=synthetic-transient-import');
    await createImport(visit.page, 1);
    await importSettled(visit.page);
    await expectOutcome(visit.page, 'TRANSIENT_KEY', 'Created');
    expect(statuses).toEqual([503, 201]);
    expect(visit.traffic.posts).toHaveLength(2);
    expectWriteIds(visit.traffic.posts, 1);
    await expectStoredValues(visit, {
      TRANSIENT_KEY: 'synthetic-transient-import',
    });
  } finally {
    await visit.close();
  }
});

it('E12: a response lost after a real commit retries the same id and returns the original success once', async () => {
  const responses: { status: number; version: string }[] = [];
  const visit = await importPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', async (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        const response = await route.fetch();
        responses.push({
          status: response.status(),
          version: (await response.json()).version,
        });
        if (responses.length === 1)
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        return route.fulfill({ response });
      });
    },
  });
  try {
    await reviewPaste(visit.page, `${lostName}=${lostValue}`);
    await createImport(visit.page, 1);
    await importSettled(visit.page);
    await expectOutcome(visit.page, lostName, 'Created');
    expect(visit.traffic.posts).toHaveLength(2);
    expectWriteIds(visit.traffic.posts, 1);
    expect(responses).toEqual(
      Array(2).fill({ status: 201, version: visit.traffic.posts[0].writeId }),
    );
    expect(
      (await listSecrets(visit.app)).filter(
        ({ name, bucket }) => bucket === importBucket && name === lostName,
      ),
    ).toHaveLength(1);
    await expectStoredValues(visit, { [lostName]: lostValue });
  } finally {
    await visit.close();
  }
});

it.each([
  {
    state: 'committed',
    final: 'Created',
    attempts: 3,
    responses: [201, 201, 201],
  },
  {
    state: 'other',
    final: 'Already exists',
    attempts: 3,
    responses: [503, 409, 409],
  },
  { state: 'absent', final: 'Failed', attempts: 3, responses: [503, 503, 503] },
  {
    state: 'negative',
    final: 'Already exists',
    attempts: 2,
    responses: [503, 409],
  },
  {
    state: 'key-missing',
    final: 'Created',
    attempts: 2,
    responses: [201, 503],
  },
] as const)(
  'E13/state space: $state stays Not confirmed until one list read settles it as $final',
  async ({ state, final, attempts, responses }) => {
    const visit = await importPage(browser);
    const { page, app, traffic } = visit;
    const loss = await loseImportResponses(page, app, state);
    try {
      await reviewPaste(page, `${lostName}=${lostValue}`);
      const reads = traffic.listReads();
      loss.arm();
      await createImport(page, 1);
      await expectOutcome(page, lostName, 'Not confirmed');
      await expect.poll(loss.reads).toBe(1);
      expect(traffic.posts).toHaveLength(attempts);
      expectWriteIds(traffic.posts, 1);
      expect(loss.responses).toEqual(responses);
      loss.release();
      await expectOutcome(page, lostName, final);
      await importSettled(page);
      expect(traffic.listReads() - reads).toBe(1);
      await expectLossStorage(visit, state);
      if (state === 'absent') {
        await restoreImportStorage(app);
        loss.allowRetry();
        await importSheet(page)
          .getByRole('button', { name: 'Retry failed', exact: true })
          .click();
        await expectOutcome(page, lostName, 'Created');
        await importSettled(page);
        expect(traffic.posts).toHaveLength(4);
        expectWriteIds(traffic.posts, 1);
        await expectStoredValues(visit, { [lostName]: lostValue });
      }
    } finally {
      loss.release();
      await visit.close();
    }
  },
);

async function expectLossStorage(
  visit: Awaited<ReturnType<typeof importPage>>,
  state: string,
) {
  const stored = (await listSecrets(visit.app)).filter(
    ({ bucket, name }) => bucket === importBucket && name === lostName,
  );
  if (state === 'absent') {
    expect(stored).toEqual([]);
    return;
  }
  expect(stored).toHaveLength(1);
  const isOurs = state === 'committed' || state === 'key-missing';
  expect(stored[0].version === visit.traffic.posts[0].writeId).toBe(isOurs);
  await expectStoredValues(visit, {
    [lostName]: isOurs ? lostValue : otherValue,
  });
}

it('E13/state space: VaultNotConfigured before any uncertain attempt is a definitive Failed result', async () => {
  const visit = await importPage(browser);
  try {
    await reviewPaste(visit.page, 'MISSING_KEY=synthetic-missing-vault-key');
    await visit.app.setBindings({ ...visit.app.bindings, VAULT_KEY: '' });
    await createImport(visit.page, 1);
    await importSettled(visit.page);
    await expectOutcome(visit.page, 'MISSING_KEY', 'Failed');
    expect(visit.traffic.posts).toHaveLength(1);
    expect(
      (await listSecrets(visit.app)).some(({ name }) => name === 'MISSING_KEY'),
    ).toBe(false);
    expect(await runRow(visit.page, 'MISSING_KEY').innerText()).toContain(
      'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
    );
  } finally {
    await visit.close();
  }
});

it('E13: a lost list leaves Not confirmed; Retry failed resends only that key with its original id and retained value', async () => {
  let importing = false;
  let loseList = true;
  let retry = false;
  const visit = await importPage(browser, {
    configure: async (page) => {
      await page.route('**/api/secrets', async (route) => {
        const request = route.request();
        const response = await route.fetch();
        if (request.method() === 'GET') {
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
        if (request.postDataJSON().name !== lostName || retry)
          return route.fulfill({ response });
        expect(response.status()).toBe(201);
        return route.fulfill({
          status: 503,
          json: { _tag: 'ServiceUnavailable' },
        });
      });
    },
  });
  const { page, traffic } = visit;
  try {
    await reviewPaste(
      page,
      `CONFIRMED_KEY=synthetic-import-confirmed\n${lostName}=${lostValue}`,
    );
    importing = true;
    await createImport(page, 2);
    await importSettled(page);
    await expectOutcome(page, 'CONFIRMED_KEY', 'Created');
    await expectOutcome(page, lostName, 'Not confirmed');
    const first = traffic.posts.filter(({ name }) => name === lostName);
    expect(first).toHaveLength(3);
    expectWriteIds(first, 1);
    expect(traffic.posts).toHaveLength(4);
    retry = true;
    await importSheet(page)
      .getByRole('button', { name: 'Retry failed', exact: true })
      .click();
    await expectCreated(page, ['CONFIRMED_KEY', lostName]);
    await importSettled(page);
    expect(
      traffic.posts.slice(4).map(({ name, writeId }) => ({ name, writeId })),
    ).toEqual([{ name: lostName, writeId: first[0].writeId }]);
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Retry failed', exact: true })
        .count(),
    ).toBe(0);
    await expectStoredValues(visit, {
      CONFIRMED_KEY: 'synthetic-import-confirmed',
      [lostName]: lostValue,
    });
  } finally {
    await visit.close();
  }
});

it('E14: deleting the target bucket after Review fails every selected key with Bucket not found', async () => {
  const visit = await importPage(browser);
  try {
    const before = await secretRows(visit.app);
    await reviewPaste(
      visit.page,
      'FIRST_KEY=synthetic-first\nSECOND_KEY=synthetic-second',
      'work/acme/web',
    );
    expect(
      (
        await fetch(`${visit.app.origin}/api/buckets/work%2Facme%2Fweb`, {
          method: 'DELETE',
        })
      ).status,
    ).toBe(204);
    await createImport(visit.page, 2);
    await importSettled(visit.page);
    for (const name of ['FIRST_KEY', 'SECOND_KEY']) {
      await expectOutcome(visit.page, name, 'Failed');
      expect(await runRow(visit.page, name).innerText()).toContain(
        'Bucket not found.',
      );
    }
    expect(visit.traffic.posts).toHaveLength(2);
    expect(await secretRows(visit.app)).toEqual(before);
  } finally {
    await visit.close();
  }
});

async function cancelPendingReload(page: Page) {
  const url = page.url();
  const warning = page.waitForEvent('dialog');
  const reload = page.evaluate(() => window.location.reload());
  const dialog = await warning;
  expect(dialog.type()).toBe('beforeunload');
  await dialog.dismiss();
  await reload;
  expect(page.url()).toBe(url);
}

async function checkPendingControls(page: Page, originalValue: string) {
  expect(
    await page
      .getByRole('button', { name: 'New secret', exact: true })
      .isEnabled(),
  ).toBe(false);
  const path = `${importBucket}/STRIPE_SECRET_KEY`;
  await secretRow(page, path)
    .getByRole('button', { name: `Actions for ${path}`, exact: true })
    .click();
  for (const name of ['Replace value…', 'Delete secret…'])
    expect(
      await page.getByRole('menuitem', { name, exact: true }).isEnabled(),
    ).toBe(false);
  const reveal = page.getByRole('menuitem', {
    name: 'Reveal value…',
    exact: true,
  });
  expect(await reveal.isEnabled()).toBe(true);
  await reveal.click();
  const dialog = page.getByRole('dialog', {
    name: 'STRIPE_SECRET_KEY',
    exact: true,
  });
  await expect
    .poll(() =>
      dialog.getByRole('textbox', { name: 'Value', exact: true }).inputValue(),
    )
    .toBe(originalValue);
  await page.keyboard.press('Escape');
}

it('E15: pending import locks writes, permits Reveal and navigation, shows progress and warns on leaving only while pending', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  const pool = await holdImportCreates(page);
  try {
    await reviewPaste(page);
    await createImport(page, 8);
    await expect.poll(() => pool.held.length).toBe(3);
    await importSheet(page)
      .getByRole('button', { name: 'Close', exact: true })
      .first()
      .click();
    const notice = page
      .getByRole('alert')
      .filter({ hasText: 'Importing secrets…' });
    await notice.waitFor();
    expect(await notice.innerText()).toContain(
      '0 of 8 created in work/acme/api.',
    );
    await notice
      .getByRole('button', { name: 'Show progress', exact: true })
      .waitFor();
    await checkPendingControls(page, visit.values[4]);
    await cancelPendingReload(page);
    expect(pool.held).toHaveLength(3);
    await page
      .getByRole('link', { name: 'Memory', exact: true })
      .first()
      .click();
    await page.getByRole('heading', { name: 'Memory', exact: true }).waitFor();
    await page
      .getByRole('link', { name: 'Vault', exact: true })
      .first()
      .click();
    await notice
      .getByRole('button', { name: 'Show progress', exact: true })
      .click();
    await importSheet(page)
      .getByRole('progressbar', { name: 'Import progress', exact: true })
      .waitFor();
    expect(pool.held).toHaveLength(3);
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Done', exact: true })
        .count(),
    ).toBe(0);
    pool.releaseAll();
    await importSettled(page);
    await expectCreated(page, readyNames);
    expect(
      await page
        .getByRole('button', {
          name: 'New secret',
          exact: true,
          includeHidden: true,
        })
        .isEnabled(),
    ).toBe(true);
    const warnings: string[] = [];
    page.on('dialog', async (dialog) => {
      warnings.push(dialog.type());
      await dialog.dismiss();
    });
    await observeBrowserPage(page);
    await page.reload();
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
    expect(warnings).toEqual([]);
    expect(
      await page
        .getByRole('alert')
        .filter({ hasText: /^Secret saved/ })
        .count(),
    ).toBe(0);
  } finally {
    pool.releaseAll();
    await visit.close();
  }
});

async function expectImportPrivate(page: Page) {
  await expect
    .poll(() =>
      privateClientState(page, importedValues, {
        allowRedacted: true,
        inspectReact: true,
      }),
    )
    .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
}

it('E16: Review, in-flight creation and results retain no plain imported values in React, DOM or caches', async () => {
  const visit = await importPage(browser);
  const { page } = visit;
  const pool = await holdImportCreates(page);
  try {
    await openImport(page);
    await pasteField(page).fill(mixedPaste);
    const pasted = await pasteField(page).inputValue();
    expect(pasted).toBe(mixedPaste);
    expect(pasted.includes(mixedValues.OPENAI_API_KEY)).toBe(true);
    await importSheet(page)
      .getByRole('button', { name: 'Review keys', exact: true })
      .click();
    await expectImportPrivate(page);
    await importSheet(page)
      .getByRole('button', { name: 'Back', exact: true })
      .click();
    expect(await pasteField(page).inputValue()).toBe(mixedPaste);
    await importSheet(page)
      .getByRole('button', { name: 'Review keys', exact: true })
      .click();
    await expectImportPrivate(page);
    await createImport(page, 8);
    await expect.poll(() => pool.held.length).toBe(3);
    await expectImportPrivate(page);
    pool.releaseAll();
    await importSettled(page);
    await expectImportPrivate(page);
    expect(
      await importSheet(page)
        .getByRole('button', { name: /Reveal|Copy value/ })
        .count(),
    ).toBe(0);
  } finally {
    pool.releaseAll();
    await visit.close();
  }
});

it('E17: Done drops every imported value from DOM, Query cache and mutation state, removes Retry and reopens with an empty paste', async () => {
  const visit = await importPage(browser, {
    configure: (_page, app) => failImportKey(app, 'STRIPE_WEBHOOK_SECRET'),
  });
  const { page } = visit;
  try {
    await reviewPaste(page);
    await createImport(page, 8);
    await importSettled(page);
    await expectOutcome(page, 'STRIPE_WEBHOOK_SECRET', 'Failed');
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Retry failed', exact: true })
        .isEnabled(),
    ).toBe(true);
    const sent = visit.traffic.posts.length;
    await importSheet(page)
      .getByRole('button', { name: 'Done', exact: true })
      .click();
    await expect
      .poll(() => privateClientState(page, importedValues))
      .toEqual({ found: true, absentFromCache: true, absentFromDom: true });
    expect(
      await page
        .getByRole('button', {
          name: 'Retry failed',
          exact: true,
          includeHidden: true,
        })
        .count(),
    ).toBe(0);
    await openImport(page);
    expect(await pasteField(page).inputValue()).toBe('');
    expect(
      await importSheet(page)
        .getByRole('button', { name: 'Review keys', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(visit.traffic.posts).toHaveLength(sent);
    await expectDomPrivate(page);
  } finally {
    await visit.close();
  }
});

it('E18: no request precedes Create and every body contains only checked Ready rows; existing secrets are neither overwritten nor deleted', async () => {
  const visit = await importPage(browser);
  const { page, app, traffic } = visit;
  const oversized = 'synthetic-too-long-'.repeat(4096);
  const blocked = `${mixedPaste}\nDATABASE_URL=synthetic-duplicate-database\nTOO_LONG=${oversized}`;
  const checked = readyNames.filter(
    (name) => !['DATABASE_URL', 'OPENAI_API_KEY'].includes(name),
  );
  try {
    const before = await secretRows(app);
    await reviewPaste(page, blocked);
    await importSheet(page)
      .getByRole('checkbox', { name: 'Include OPENAI_API_KEY', exact: true })
      .uncheck();
    expect(traffic.writes()).toEqual([]);
    expect(await secretRows(app)).toEqual(before);
    await createImport(page, 6);
    await importSettled(page);
    expect(
      traffic.writes().map(({ method, path }) => ({ method, path })),
    ).toEqual(Array(6).fill({ method: 'POST', path: '/api/secrets' }));
    expect(traffic.posts.map(({ name }) => name).sort()).toEqual(
      [...checked].sort(),
    );
    for (const input of traffic.posts) {
      expect(input.bucket).toBe(importBucket);
      expect(input.value === mixedValues[input.name]).toBe(true);
      expect(input.description ?? '').toBe('');
    }
    const forbidden = [
      mixedValues.DATABASE_URL,
      mixedValues.OPENAI_API_KEY,
      mixedValues.STRIPE_SECRET_KEY,
      mixedValues.SENTRY_DSN,
      mixedValues.next_public_posthog_key,
      mixedValues['AWS-REGION'],
      'synthetic-duplicate-database',
      oversized,
      'paste the slack token here later',
    ];
    for (const request of traffic.requests) {
      const body = request.body ?? '';
      expect(forbidden.map((value) => body.includes(value))).toEqual(
        forbidden.map(() => false),
      );
    }
    const after = await secretRows(app);
    for (const row of before)
      expect(
        after.find(
          (current) =>
            current.bucket === row.bucket && current.name === row.name,
        ),
      ).toEqual(row);
    expect(after).toHaveLength(before.length + 6);
    await expectStoredValues(visit, {
      SENTRY_DSN: visit.values[3],
      STRIPE_SECRET_KEY: visit.values[4],
    });
  } finally {
    await visit.close();
  }
});

it('E19: owner imports add no Audit entries to an existing audit history', async () => {
  const visit = await importPage(browser);
  try {
    const reveal = await revealSecret(
      visit.app,
      `${importBucket}/STRIPE_SECRET_KEY`,
    );
    expect(reveal.status).toBe(200);
    await reveal.body?.cancel();
    const before = await auditRows(visit.app);
    expect(before).toHaveLength(1);
    await reviewPaste(visit.page);
    await createImport(visit.page, 8);
    await importSettled(visit.page);
    await expectCreated(visit.page, readyNames);
    const after = await auditRows(visit.app);
    expect(after).toHaveLength(before.length);
    expect(after).toEqual(before);
  } finally {
    await visit.close();
  }
});

const viewports = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
];
const layouts = viewports.flatMap((viewport) =>
  ['mixed', 'results-partial'].map((state) => ({ ...viewport, state })),
);
it.each(layouts)(
  'E20a: $state at $width×$height has no horizontal overflow or console errors',
  async ({ width, height, state }) => {
    const errors: string[] = [];
    let release = () => {};
    const visit = await importPage(browser, {
      viewport: { width, height },
      configure: async (page, app) => {
        await observeImportConsole(page, errors);
        if (state === 'results-partial')
          release = await partialImportResults(page, app);
      },
    });
    const { page } = visit;
    try {
      await reviewPaste(page);
      if (state === 'results-partial') {
        await createImport(page, 8);
        await importSettled(page);
        await expectCreated(
          page,
          readyNames.filter(
            (name) =>
              !['STRIPE_WEBHOOK_SECRET', 'GITHUB_APP_ID'].includes(name),
          ),
        );
        await expectOutcome(page, 'STRIPE_WEBHOOK_SECRET', 'Failed');
        await expectOutcome(page, 'GITHUB_APP_ID', 'Not confirmed');
        await importSheet(page)
          .getByRole('heading', {
            name: 'Import finished with problems',
            exact: true,
          })
          .waitFor();
        expect(
          await importSheet(page)
            .getByRole('button', { name: 'Retry failed', exact: true })
            .isEnabled(),
        ).toBe(true);
      } else await expectMixedReview(page);
      const widths = await page.evaluate(() => {
        const sheet = document.querySelector('[role="dialog"]');
        if (!sheet)
          throw new Error('Import Sheet missing during layout check.');
        return {
          page: document.documentElement.scrollWidth,
          viewport: innerWidth,
          sheet: sheet.scrollWidth,
          sheetClient: sheet.clientWidth,
        };
      });
      expect(widths.page).toBe(widths.viewport);
      expect(widths.viewport).toBe(width);
      expect(widths.sheet).toBeLessThanOrEqual(widths.sheetClient);
      expect(errors).toEqual([]);
    } finally {
      release();
      await visit.close();
    }
  },
);

it('E2/E7/E9: exactly 100 keys round-trip CRLF, a 64 KiB UTF-8 value, multiline text and literal variable references', async () => {
  const visit = await importPage(browser);
  const values = Object.fromEntries(
    Array.from({ length: 100 }, (_, index) => [
      `KEY_${index}`,
      `synthetic-import-extreme-${index}`,
    ]),
  );
  values.KEY_0 = '🔐'.repeat(16 * 1024);
  values.KEY_1 = 'first\nsecond\nthird';
  values.KEY_2 = `秘密 café \${KEY_1}`;
  const text = Object.entries(values)
    .map(([name, value]) => `${name}="${value}"`)
    .join('\n')
    .replaceAll('\n', '\r\n');
  try {
    await reviewPaste(visit.page, text);
    await createImport(visit.page, 100);
    // 100 writes at three in flight outlast the default wait on CI runners.
    await importSettled(visit.page, 20_000);
    await expectCreated(visit.page, Object.keys(values));
    expect(visit.traffic.posts).toHaveLength(100);
    expectWriteIds(visit.traffic.posts, 100);
    expect(
      (await listSecrets(visit.app)).filter(
        ({ bucket }) => bucket === importBucket,
      ),
    ).toHaveLength(102);
    await expectStoredValues(visit, values);
  } finally {
    await visit.close();
  }
});
