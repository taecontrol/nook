import type { Browser, Locator, Page, Request } from 'playwright';
import { expect } from 'vitest';
import {
  importBucket,
  importedValues,
  importSeeds,
  mixedPaste,
} from '../fixtures/vault-import.ts';
import { seedGrantTree } from './grants.ts';
import { deferred } from './machines.ts';
import type { TestRuntime } from './runtime.ts';
import { decryptRow, secretRows, vaultRuntime } from './vault.ts';
import { secretRow, vaultPage } from './vault-browser.ts';

export type ImportVisit = Awaited<ReturnType<typeof importPage>>;
export type CreateAttempt = {
  bucket: string;
  name: string;
  description?: string;
  value: string;
  writeId: string;
};
type RecordedRequest = { method: string; path: string; body: string | null };

export function recordImportRequests(page: Page) {
  const requests: RecordedRequest[] = [];
  const posts: CreateAttempt[] = [];
  page.on('request', (request: Request) => {
    const path = new URL(request.url()).pathname;
    if (!path.startsWith('/api/')) return;
    requests.push({ method: request.method(), path, body: request.postData() });
    if (path === '/api/secrets' && request.method() === 'POST')
      posts.push(request.postDataJSON());
  });
  return {
    requests,
    posts,
    listReads: () =>
      requests.filter(
        (entry) => entry.path === '/api/secrets' && entry.method === 'GET',
      ).length,
    writes: () =>
      requests.filter((entry) =>
        ['POST', 'PUT', 'DELETE', 'PATCH'].includes(entry.method),
      ),
  };
}

export async function importPage(
  browser: Browser,
  options: Omit<
    NonNullable<Parameters<typeof vaultPage>[1]>,
    'app' | 'seeds' | 'fresh'
  > = {},
) {
  const app = await vaultRuntime();
  try {
    await seedGrantTree(app, ['me/tessel', importBucket, 'work/acme/web']);
  } catch (error) {
    await app.close();
    throw error;
  }
  let traffic: ReturnType<typeof recordImportRequests> | undefined;
  const visit = await vaultPage(browser, {
    ...options,
    app,
    seeds: importSeeds,
    start: options.start ?? `/vault?bucket=${importBucket}`,
    configure: async (page, runtime) => {
      traffic = recordImportRequests(page);
      await options.configure?.(page, runtime);
    },
  });
  try {
    if (!traffic) throw new Error('Import request recorder did not start.');
    // This must pass before looking for the missing import UI: build, migration,
    // encryption, owner authentication and the metadata query all work.
    await secretRow(visit.page, `${importBucket}/SENTRY_DSN`).waitFor();
    await secretRow(visit.page, `${importBucket}/STRIPE_SECRET_KEY`).waitFor();
    expect(
      await visit.page
        .getByRole('heading', { name: 'Vault', exact: true })
        .isVisible(),
    ).toBe(true);
    expect(
      await visit.page
        .getByRole('region', { name: 'Stored here', exact: true })
        .locator('[data-secret]')
        .count(),
    ).toBe(2);
    await visit.page.waitForLoadState('networkidle');
    return { ...visit, traffic };
  } catch (error) {
    await visit.close();
    throw error;
  }
}

export const importSheet = (page: Page) => page.getByRole('dialog');
export const pasteField = (page: Page) =>
  importSheet(page).getByRole('textbox', {
    name: '.env contents',
    exact: true,
  });

export async function openImport(page: Page) {
  await page.getByRole('button', { name: 'Import .env', exact: true }).click();
  const sheet = page.getByRole('dialog', { name: 'Import .env', exact: true });
  await sheet.waitFor();
  return sheet;
}
export async function chooseImportBucket(page: Page, bucket: string) {
  await importSheet(page)
    .getByRole('combobox', { name: 'Bucket', exact: true })
    .click();
  await page.getByRole('option', { name: bucket, exact: true }).click();
}
export async function reviewPaste(
  page: Page,
  text = mixedPaste,
  bucket?: string,
) {
  await openImport(page);
  if (bucket) await chooseImportBucket(page, bucket);
  await pasteField(page).fill(text);
  await importSheet(page)
    .getByRole('button', { name: 'Review keys', exact: true })
    .click();
  await importSheet(page)
    .getByText(/Step 2 of 2\./)
    .waitFor();
  return importSheet(page);
}
export async function createImport(page: Page, count: number) {
  await importSheet(page)
    .getByRole('button', {
      name: `Create ${count} secret${count === 1 ? '' : 's'}`,
      exact: true,
    })
    .click();
}
export const reviewRow = (page: Page, line: number) =>
  importSheet(page)
    .getByRole('listitem')
    .filter({
      has: page.getByRole('textbox', {
        name: `Name from line ${line}`,
        exact: true,
      }),
    });
export const runRow = (page: Page, name: string) =>
  importSheet(page)
    .getByRole('listitem')
    .filter({
      has: page.getByText(name, { exact: true }),
    });
export async function expectOutcome(page: Page, name: string, status: string) {
  await runRow(page, name).getByText(status, { exact: true }).waitFor();
}
export async function expectCreated(page: Page, names: readonly string[]) {
  for (const name of names) await expectOutcome(page, name, 'Created');
}
export async function importSettled(page: Page, timeout?: number) {
  await importSheet(page)
    .getByRole('button', { name: 'Done', exact: true })
    .waitFor({ timeout });
  await page.waitForLoadState('networkidle');
}
export async function expectDomPrivate(page: Page, values = importedValues) {
  const exposed = await page.evaluate((values) => {
    const dom = document.documentElement.innerHTML;
    const fields = Array.from(document.querySelectorAll('input, textarea')).map(
      (field) => (field as HTMLInputElement).value,
    );
    return values.map(
      (value) =>
        dom.includes(value) || fields.some((field) => field.includes(value)),
    );
  }, values);
  expect(exposed).toEqual(values.map(() => false));
}

export async function holdImportCreates(page: Page) {
  const held: { input: CreateAttempt; gate: ReturnType<typeof deferred> }[] =
    [];
  const active = new Set<Request>();
  let peak = 0;
  let released = false;
  page.on('request', (request) => {
    if (
      new URL(request.url()).pathname !== '/api/secrets' ||
      request.method() !== 'POST'
    )
      return;
    active.add(request);
    peak = Math.max(peak, active.size);
  });
  page.on('requestfinished', (request) => {
    active.delete(request);
  });
  page.on('requestfailed', (request) => {
    active.delete(request);
  });
  await page.route('**/api/secrets', async (route) => {
    if (route.request().method() !== 'POST') return route.continue();
    const gate = deferred();
    held.push({ input: route.request().postDataJSON(), gate });
    if (released) gate.resolve();
    await gate.promise;
    await route.continue().catch(() => {});
  });
  return {
    held,
    active: () => active.size,
    peak: () => peak,
    releaseAll() {
      released = true;
      for (const request of held) request.gate.resolve();
    },
  };
}

export async function failImportKey(app: TestRuntime, name: string) {
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'CREATE TRIGGER import_failure BEFORE INSERT ON secrets WHEN NEW.name = ' +
        `'${name}' BEGIN SELECT RAISE(ABORT, 'Synthetic import D1 failure'); END`,
    )
    .run();
}
export async function restoreImportStorage(app: TestRuntime) {
  await (await app.mf.getD1Database('DB'))
    .prepare('DROP TRIGGER import_failure')
    .run();
}
export async function expectStoredValues(
  visit: ImportVisit,
  values: Readonly<Record<string, string>>,
  bucket = importBucket,
) {
  const rows = await secretRows(visit.app);
  for (const [name, value] of Object.entries(values)) {
    const row = rows.find((row) => row.bucket === bucket && row.name === name);
    expect(row, `Stored metadata for ${bucket}/${name}`).toBeDefined();
    if (!row)
      throw new Error(`Stored metadata for ${bucket}/${name} is missing.`);
    expect((await decryptRow(visit.app.key, row)) === value).toBe(true);
  }
}
export function expectWriteIds(posts: readonly CreateAttempt[], count: number) {
  expect(new Set(posts.map(({ writeId }) => writeId)).size).toBe(count);
  for (const { writeId } of posts)
    expect(writeId).toMatch(
      /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i,
    );
}
export async function shortFailure(row: Locator) {
  const text = await row.innerText();
  expect(text).toMatch(/(could not|unavailable|try again|no longer stored)/i);
  expect(text.length).toBeLessThan(300);
  expect(text).not.toMatch(/SQLITE|RAISE|Synthetic import D1 failure|stack/i);
}

export async function observeImportConsole(page: Page, errors: string[]) {
  page.on('pageerror', (error) => errors.push(error.name));
  await page.exposeFunction('recordImportConsoleError', () => {
    errors.push('console.error');
  });
  await page.addInitScript(() => {
    // Observe application log calls. Chromium's own HTTP-failure diagnostics
    // are network events; the partial-results fixture deliberately causes 503s.
    const original = console.error.bind(console);
    console.error = (...args: unknown[]) => {
      const observer = window as unknown as {
        recordImportConsoleError(): Promise<void>;
      };
      void observer.recordImportConsoleError();
      original(...args);
    };
  });
}
