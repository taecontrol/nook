import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
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

type Operation = 'create' | 'replace' | 'delete';
const targetPath = (op: Operation) =>
  `work/acme/${op === 'create' ? 'RESEND_API_KEY' : 'STRIPE_KEY'}`;
async function submit(page: Page, op: Operation) {
  if (op === 'create') {
    const sheet = await createDraft(page);
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    return;
  }
  if (op === 'replace') await replaceDraft(page);
  else await openSecretMenu(page, targetPath(op), 'Delete secret…');
  await page
    .getByRole('alertdialog')
    .getByRole('button', {
      name: op === 'replace' ? 'Replace value' : 'Delete secret',
      exact: true,
    })
    .click();
}
async function retry(page: Page) {
  await page
    .getByRole('alert')
    .filter({ has: page.getByRole('button', { name: 'Dismiss', exact: true }) })
    .getByRole('button', { name: 'Try again', exact: true })
    .click();
}

it.each(['replace', 'delete'] as const)(
  'E21: a negative %s retry after a lost commit stays unconfirmed until listing',
  async (op) => {
    let attempts = 0;
    const path = targetPath(op);
    const visit = await vaultPage(browser, {
      configure: async (page, app) => {
        await page.route('**/api/secrets**', async (route) => {
          if (route.request().method() === 'GET') return route.continue();
          const response = await route.fetch();
          if (++attempts !== 1) {
            expect(response.status()).toBe(op === 'replace' ? 409 : 404);
            expect((await response.json())._tag).toBe(
              op === 'replace' ? 'SecretChanged' : 'SecretNotFound',
            );
            return route.fulfill({ response });
          }
          expect(response.status()).toBe(op === 'replace' ? 200 : 204);
          if (op === 'replace') {
            const current = (await listSecrets(app)).find(
              (row) => row.path === path,
            )!;
            expect(
              (
                await replaceSecret(app, path, {
                  ...secretInput({ description: 'Changed in another session' }),
                  expectedVersion: current.version,
                })
              ).status,
            ).toBe(200);
          }
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        });
      },
    });
    const { page, app } = visit;
    try {
      await submit(page, op);
      const feedback = page.getByRole('alert').filter({
        has: page.getByRole('button', { name: 'Dismiss', exact: true }),
      });
      await feedback.waitFor();
      expect(await feedback.innerText()).toContain(
        'Nook could not confirm whether',
      );
      expect(await feedback.innerText()).not.toMatch(
        /Nothing (was stored|changed)/,
      );
      expect(attempts).toBe(2);
      await retry(page);
      await feedback
        .filter({
          has: page.getByText('Current secret state', { exact: true }),
        })
        .waitFor();
      expect(await feedback.innerText()).toContain(
        op === 'replace'
          ? `${path} changed in another session. Review it and try again.`
          : `${path} is no longer stored.`,
      );
      const current = (await listSecrets(app)).find((row) => row.path === path);
      expect(await secretRow(page, path).count()).toBe(current ? 1 : 0);
      if (current) {
        expect(await secretRow(page, path).innerText()).toContain(
          current.description,
        );
        expect(await secretRow(page, path).innerText()).not.toContain(
          'Confirming',
        );
      }
      expect(attempts).toBe(2);
    } finally {
      await visit.close();
    }
  },
);

it.each([
  [
    'name',
    { name: 'resend_api_key' },
    'Use uppercase letters, digits, and underscores, starting with a letter or underscore.',
  ],
  [
    'description',
    { description: '😀'.repeat(201) },
    'A description can have at most 200 characters.',
  ],
  ['value', { value: '' }, 'Enter a value.'],
] as const)(
  'E19/E21: an invalid %s remains editable and sends no write',
  async (_field, draft, message) => {
    const visit = await vaultPage(browser);
    try {
      const before = await secretRows(visit.app);
      const sheet = await createDraft(visit.page, draft);
      await sheet
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      await sheet.getByText(message, { exact: true }).waitFor();
      expect(
        visit.requests.filter((request) => request.method === 'POST'),
      ).toEqual([]);
      expect(await secretRows(visit.app)).toEqual(before);
      expect(
        await sheet
          .getByRole('textbox', { name: 'Name', exact: true })
          .inputValue(),
      ).toBe('name' in draft ? draft.name : 'RESEND_API_KEY');
    } finally {
      await visit.close();
    }
  },
);

it.each(['create', 'replace', 'delete'] as const)(
  'E21: a definitive %s failure can be retried with a fresh confirmation and no retained value',
  async (op) => {
    const visit = await vaultPage(browser);
    const { page, app } = visit;
    try {
      await secretRow(page, 'work/acme/STRIPE_KEY').waitFor();
      const before = await secretRows(app);
      await app.setBindings({ ...app.bindings, LOCAL_OWNER: '' });
      await submit(page, op);
      await page
        .getByRole('alert')
        .filter({ hasText: /Nothing (was stored|changed)\./ })
        .waitFor();
      expect(await secretRows(app)).toEqual(before);
      expect(
        await privateClientState(page, [
          'synthetic-browser-vault-value',
          'synthetic-browser-replacement',
        ]),
      ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
      await app.setBindings(app.bindings);
      await retry(page);
      if (op === 'delete') {
        await page
          .getByRole('alertdialog')
          .getByRole('button', { name: 'Delete secret', exact: true })
          .click();
      } else {
        const sheet = page.getByRole('dialog');
        const value = sheet.getByRole('textbox', {
          name: op === 'create' ? 'Value' : 'New value',
          exact: true,
        });
        expect(await value.inputValue()).toBe('');
        if (op === 'create') {
          expect(
            await sheet
              .getByRole('textbox', { name: 'Name', exact: true })
              .inputValue(),
          ).toBe('RESEND_API_KEY');
          expect(
            await sheet
              .getByRole('textbox', { name: 'Description', exact: true })
              .inputValue(),
          ).toBe('Transactional email for staging');
        }
        await value.fill('synthetic-retry-value');
        await sheet
          .getByRole('button', {
            name: op === 'create' ? 'Save secret' : 'Replace value…',
            exact: true,
          })
          .click();
        if (op === 'replace')
          await page
            .getByRole('alertdialog')
            .getByRole('button', { name: 'Replace value', exact: true })
            .click();
      }
      await page
        .getByRole('alert')
        .filter({
          has: page.getByText(
            {
              create: 'Secret saved',
              replace: 'Value replaced',
              delete: 'Secret deleted',
            }[op],
            { exact: true },
          ),
        })
        .waitFor();
      const rows = await listSecrets(app);
      expect(rows.some((row) => row.path === targetPath(op))).toBe(
        op !== 'delete',
      );
      expect(await privateClientState(page, ['synthetic-retry-value'])).toEqual(
        { found: true, absentFromCache: true, absentFromDom: true },
      );
    } finally {
      await visit.close();
    }
  },
);

it.each([
  ['create', 'other', 'now exists. Review it before trying again.'],
  ['replace', 'unchanged', 'is still stored with the version you last saw.'],
  ['replace', 'other', 'changed in another session. Review it and try again.'],
  ['replace', 'absent', 'is no longer stored.'],
  ['replace', 'committed', null],
  ['delete', 'unchanged', 'is still stored with the version you last saw.'],
  ['delete', 'other', 'changed in another session. Review it and try again.'],
  ['delete', 'committed', 'is no longer stored.'],
] as const)(
  'E21: an unconfirmed %s reconciles the %s state without attributing another writer’s change',
  async (op, outcome, message) => {
    const attempts: string[] = [];
    const visit = await vaultPage(browser, {
      configure: async (page) => {
        await page.route('**/api/secrets**', async (route) => {
          const request = route.request();
          if (request.method() === 'GET') return route.continue();
          attempts.push(
            op === 'delete'
              ? new URL(request.url()).searchParams.get('version')!
              : request.postDataJSON().writeId,
          );
          if (outcome === 'committed' && attempts.length === 1)
            await route.fetch();
          return route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
        });
      },
    });
    const { page, app } = visit;
    const path = targetPath(op);
    try {
      await submit(page, op);
      await page
        .getByRole('alert')
        .filter({ hasText: 'could not confirm' })
        .waitFor();
      expect(attempts).toHaveLength(3);
      expect(new Set(attempts).size).toBe(1);
      expect(await page.getByRole('alert').innerText()).not.toMatch(
        /Nothing (was stored|changed)/,
      );
      if (outcome === 'other' && op === 'create') {
        expect(
          (
            await createSecret(
              app,
              secretInput({
                name: 'RESEND_API_KEY',
                description: 'Created in another session',
              }),
            )
          ).status,
        ).toBe(201);
      } else if (outcome === 'other' || outcome === 'absent') {
        const current = (await listSecrets(app)).find(
          (row) => row.path === path,
        )!;
        const response =
          outcome === 'absent'
            ? await deleteSecret(app, path, current.version)
            : await replaceSecret(app, path, {
                ...secretInput({ description: 'Changed in another session' }),
                expectedVersion: current.version,
              });
        expect(response.status).toBe(outcome === 'absent' ? 204 : 200);
      }
      await retry(page);
      if (message) {
        await page
          .getByRole('alert')
          .filter({
            has: page.getByText('Current secret state', { exact: true }),
          })
          .waitFor();
        expect(await page.getByRole('alert').innerText()).toContain(
          `${path} ${message}`,
        );
      } else {
        await page
          .getByRole('alert')
          .filter({ has: page.getByText('Value replaced', { exact: true }) })
          .waitFor();
      }
      const current = (await listSecrets(app)).find((row) => row.path === path);
      expect(await secretRow(page, path).count()).toBe(current ? 1 : 0);
      if (current) {
        expect(await secretRow(page, path).innerText()).not.toContain(
          'Confirming',
        );
        if (outcome === 'other')
          expect(await secretRow(page, path).innerText()).toContain(
            current.description,
          );
      }
    } finally {
      await visit.close();
    }
  },
);
