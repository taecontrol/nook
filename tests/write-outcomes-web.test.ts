import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  issueToken,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { listMachines, machineIdentity } from './support/machines.ts';
import { confirmRevoke, machineRow } from './support/machines-browser.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

async function ownerPage(app: TestRuntime, path: string) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  try {
    await page.goto(app.origin + path);
    return {
      page,
      close: () => closeBrowserPage(page, context),
    };
  } catch (error) {
    await closeBrowserPage(page, context);
    throw error;
  }
}

async function deleteBucket(page: Page, path: string) {
  await page
    .getByRole('button', { name: `Actions for ${path}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: 'Delete bucket…' }).click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Delete bucket', exact: true })
    .click();
}

it.each([
  { operation: 'create', recovery: 'successful' },
  { operation: 'create', recovery: 'failed' },
  { operation: 'delete', recovery: 'successful' },
  { operation: 'delete', recovery: 'failed' },
] as const)(
  'a lost reply after a committed bucket $operation does not claim rollback with a $recovery recovery read',
  async ({ operation, recovery }) => {
    const app = await ownerRuntime(await runtime());
    let visit: Awaited<ReturnType<typeof ownerPage>> | undefined;
    let tableUnavailable = false;
    try {
      const path = 'work/feedback-target';
      expect(
        (
          await jsonRequest(app, '/api/buckets', {
            path: operation === 'create' ? 'work' : path,
          })
        ).status,
      ).toBe(200);
      visit = await ownerPage(app, '/buckets');
      const { page } = visit;
      await page
        .getByRole('button', { name: 'Actions for work', exact: true })
        .waitFor();
      await page.waitForLoadState('networkidle');
      const db = await app.mf.getD1Database('DB');
      const method = operation === 'create' ? 'POST' : 'DELETE';
      let committedStatus: number | undefined;
      await page.route('**/api/buckets**', async (route) => {
        if (route.request().method() !== method) return route.continue();
        const response = await route.fetch();
        committedStatus = response.status();
        if (recovery === 'failed') {
          await db
            .prepare('ALTER TABLE buckets RENAME TO unavailable_buckets')
            .run();
          tableUnavailable = true;
        }
        // The genuine Worker has already committed; only its reply is lost.
        await route.abort('failed');
      });
      const recovered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/buckets' &&
          response.request().method() === 'GET',
      );
      const field = page.getByRole('textbox', { name: 'New bucket path' });
      if (operation === 'create') {
        await field.fill(path);
        await field.press('Enter');
      } else {
        await deleteBucket(page, path);
      }
      const response = await recovered;
      expect(response.status()).toBe(recovery === 'successful' ? 200 : 503);
      await response.finished();
      expect(committedStatus).toBe(operation === 'create' ? 200 : 204);
      const stored = await db
        .prepare(
          `SELECT path FROM ${tableUnavailable ? 'unavailable_buckets' : 'buckets'} WHERE path=?`,
        )
        .bind(path)
        .first();
      expect(Boolean(stored), 'The write really committed in D1').toBe(
        operation === 'create',
      );
      await expect.poll(() => field.isEnabled()).toBe(true);
      if (recovery === 'successful') {
        await expect
          .poll(() =>
            page
              .getByRole('button', {
                name: `Actions for ${path}`,
                exact: true,
              })
              .count(),
          )
          .toBe(operation === 'create' ? 1 : 0);
      } else {
        await page
          .getByText("Couldn't refresh buckets", { exact: true })
          .waitFor();
      }
      const feedback = page.getByRole('alert').filter({ hasText: path });
      await expect.poll(() => feedback.count()).toBe(1);
      expect(
        await feedback.innerText(),
        'Losing a committed write reply cannot prove that nothing changed',
      ).not.toMatch(/Nothing was created|The bucket is still there/i);
    } finally {
      try {
        if (tableUnavailable)
          await (await app.mf.getD1Database('DB'))
            .prepare('ALTER TABLE unavailable_buckets RENAME TO buckets')
            .run();
      } finally {
        try {
          await visit?.close();
        } finally {
          await app.close();
        }
      }
    }
  },
);

it.each(['successful', 'failed'] as const)(
  'a genuine 503 after committed machine revocation never claims its token works with a %s recovery read',
  async (recovery) => {
    let failNextBatch = false;
    let afterCommitFailures = 0;
    const app = await vaultCheckpoints(async (label) => {
      if (label !== '/after-batch' || !failNextBatch) return true;
      failNextBatch = false;
      afterCommitFailures++;
      return false;
    });
    let visit: Awaited<ReturnType<typeof ownerPage>> | undefined;
    let tableUnavailable = false;
    try {
      const { token } = await issueToken(app, 'feedback-machine');
      const [machine] = await listMachines(app);
      visit = await ownerPage(app, '/machines');
      const { page } = visit;
      await machineRow(page, machine.id).waitFor();
      await page.waitForLoadState('networkidle');
      const db = await app.mf.getD1Database('DB');
      if (recovery === 'failed')
        await page.route('**/api/machines', async (route) => {
          if (!tableUnavailable) {
            await db
              .prepare(
                'ALTER TABLE machine_tokens RENAME TO unavailable_machine_tokens',
              )
              .run();
            tableUnavailable = true;
          }
          await route.continue();
        });
      const writeResponse = page.waitForResponse(
        (response) =>
          response.request().method() === 'DELETE' &&
          new URL(response.url()).pathname === `/api/machines/${machine.id}`,
      );
      const recovered = page.waitForResponse(
        (response) =>
          new URL(response.url()).pathname === '/api/machines' &&
          response.request().method() === 'GET',
      );
      failNextBatch = true;
      await confirmRevoke(page, machine.id);
      const write = await writeResponse;
      expect(write.status()).toBe(503);
      expect((await write.json())._tag).toBe('ServiceUnavailable');
      expect(afterCommitFailures).toBe(1);
      const response = await recovered;
      expect(response.status()).toBe(recovery === 'successful' ? 200 : 503);
      await response.finished();
      const stored = await db
        .prepare(
          `SELECT id FROM ${tableUnavailable ? 'unavailable_machine_tokens' : 'machine_tokens'} WHERE id=?`,
        )
        .bind(machine.id)
        .first();
      expect(Boolean(stored), 'The DELETE really revoked the machine').toBe(
        false,
      );
      if (tableUnavailable) {
        await page
          .getByText("Couldn't refresh machines", { exact: true })
          .waitFor();
        await db
          .prepare(
            'ALTER TABLE unavailable_machine_tokens RENAME TO machine_tokens',
          )
          .run();
        tableUnavailable = false;
      } else {
        await expect.poll(() => machineRow(page, machine.id).count()).toBe(0);
      }
      const identity = await machineIdentity(app, token);
      expect(identity.status, 'The real revoked credential is denied').toBe(
        401,
      );
      await identity.body?.cancel();
      const feedback = page
        .getByRole('alert')
        .filter({ hasText: machine.name });
      await expect.poll(() => feedback.innerText()).not.toMatch(/^Revoking /);
      expect(
        await feedback.innerText(),
        'A post-commit storage error does not mean a credential still works',
      ).not.toMatch(/is still connected|token still works/i);
    } finally {
      try {
        if (tableUnavailable)
          await (await app.mf.getD1Database('DB'))
            .prepare(
              'ALTER TABLE unavailable_machine_tokens RENAME TO machine_tokens',
            )
            .run();
      } finally {
        try {
          await visit?.close();
        } finally {
          await app.close();
        }
      }
    }
  },
);
