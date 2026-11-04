import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../../scripts/lib/test-browser.ts';
import { issueToken } from '../support/authorizations.ts';
import { seedGrantTree } from '../support/grants.ts';
import { deferred } from '../support/machines.ts';
import {
  age,
  ask,
  cloudflare,
  database,
  decide,
  mark,
  setMark,
  stripe,
  withdraw,
} from '../support/owner-approval.ts';
import {
  type ApprovalApp,
  approvalBrowserPage,
  approvalWebApp,
  approveButton,
  duration,
  expectPendingPage,
  longPurpose,
  webPending,
} from '../support/owner-approval-browser.ts';
import { expectNoOverflow } from '../support/page-checks.ts';
import { createSecret, secretInput } from '../support/vault.ts';

const directory = resolve('.local/verification/screenshots/owner-approval');
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser());
const mobile = [
  'pending',
  'pending-many',
  'pending-no-session',
  'submitting',
  'approved',
  'denied',
  'withdrawn',
  'expired',
  'settled',
  'decision-expired',
  'list',
  'list-empty',
  'vault-marks',
] as const;
type State = (typeof mobile)[number];
const main = ['pending', 'list', 'vault-marks'] as const;
const matrix = [
  ...mobile.map((state) => ({
    state,
    width: 390,
    height: 844,
    theme: 'light' as const,
  })),
  ...main.map((state) => ({
    state,
    width: 390,
    height: 844,
    theme: 'dark' as const,
  })),
  ...[...main, 'pending-many' as const].map((state) => ({
    state,
    width: 1440,
    height: 900,
    theme: 'light' as const,
  })),
];
async function listState(app: ApprovalApp) {
  const first = await webPending(app);
  await webPending(app, {
    secrets: [stripe, database, cloudflare],
    purpose: longPurpose,
  });
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'UPDATE approval_requests SET requested_at=requested_at-1 WHERE id=?',
    )
    .bind(first.id)
    .run();
  const remembered = await webPending(app, { secrets: [stripe, database] });
  expect((await decide(app, remembered.id, '1h')).status).toBe(200);
  const other = await issueToken(app, 'lg16');
  const later = await webPending(
    { ...app, token: other.token },
    { secrets: [cloudflare] },
  );
  expect((await decide(app, later.id, '12h')).status).toBe(200);
  // The desktop reference includes a 12-hour approval given at 09:10.
  await (await app.mf.getD1Database('DB'))
    .prepare(
      'UPDATE approval_requests SET requested_at=requested_at-5520000,expires_at=expires_at-5520000,decided_at=decided_at-5520000,valid_until=valid_until-5520000 WHERE id=?',
    )
    .bind(later.id)
    .run();
}
async function vaultState(app: ApprovalApp) {
  await seedGrantTree(app, ['work/old-client', 'work/acme/prod/eu-west']);
  await setMark(app, 'work/old-client');
  expect(
    (
      await fetch(`${app.origin}/api/buckets/work%2Fold-client`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await createSecret(
        app,
        secretInput({
          name: 'GITHUB_TOKEN',
          description: 'Deploy token for acme/web',
        }),
      )
    ).status,
  ).toBe(201);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('DELETE FROM secrets WHERE name=?').bind('GH_TOKEN').run();
  await db
    .prepare('DELETE FROM secrets WHERE bucket=?')
    .bind('work/acme2')
    .run();
  expect(
    (
      await fetch(`${app.origin}/api/buckets/work%2Facme2`, {
        method: 'DELETE',
      })
    ).status,
  ).toBe(204);
  expect(
    (
      await createSecret(
        app,
        secretInput({ bucket: 'work/acme/prod/eu-west', name: 'DEPLOY_TOKEN' }),
      )
    ).status,
  ).toBe(201);
  await db
    .prepare('UPDATE secrets SET updated_at=?')
    .bind('2026-11-02T10:42:00.000Z')
    .run();
  await db
    .prepare('UPDATE secrets SET description=? WHERE bucket=? AND name=?')
    .bind('Stripe live secret key', 'work/acme', 'STRIPE_KEY')
    .run();
  // Keep the badge visible in the main Vault references as well.
  await webPending(app);
  await webPending(app, {
    secrets: [stripe, database, cloudflare],
    purpose: longPurpose,
  });
}
async function terminal(
  app: ApprovalApp,
  request: Awaited<ReturnType<typeof webPending>>,
  state: State,
) {
  if (state === 'approved')
    expect((await decide(app, request.id, '1h')).status).toBe(200);
  if (state === 'denied')
    expect((await decide(app, request.id, 'deny')).status).toBe(200);
  if (state === 'withdrawn')
    expect((await withdraw(app, app.token, request.id)).status).toBe(204);
  if (state === 'expired') await age(app, request.id, 'expires_at', 600_000);
  if (state === 'settled') {
    expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
    const delivered = await ask(
      app,
      app.token,
      request.attemptId,
      request.input,
    );
    expect(delivered.status).toBe(200);
    await delivered.body?.cancel();
  }
}
async function openState(
  page: Page,
  app: ApprovalApp,
  state: State,
  gate: ReturnType<typeof deferred>,
) {
  if (state === 'list' || state === 'list-empty') {
    if (state === 'list') await listState(app);
    await page.goto(`${app.origin}/approvals`);
    await page
      .getByRole('heading', { name: 'Approvals', exact: true })
      .waitFor();
    if (state === 'list-empty')
      await page
        .getByText('Nothing waiting for you', { exact: true })
        .waitFor();
    else
      await page
        .getByRole('link', { name: 'Review', exact: true })
        .first()
        .waitFor();
    return;
  }
  if (state === 'vault-marks') {
    await vaultState(app);
    await page.goto(`${app.origin}/vault?bucket=work%2Facme`);
    await page
      .getByRole('switch', { name: 'Ask first for work/acme', exact: true })
      .waitFor();
    await page.locator('[data-secret="work/acme/GITHUB_TOKEN"]').waitFor();
    return;
  }
  const request = await webPending(
    app,
    state === 'pending-many'
      ? { secrets: [stripe, database, cloudflare], purpose: longPurpose }
      : state === 'pending-no-session'
        ? { agentSession: undefined }
        : {},
  );
  await terminal(app, request, state);
  if (state === 'submitting')
    await page.route(
      `**/api/approvals/${request.id}/approve`,
      async (route) => {
        await gate.promise;
        await route.continue().catch(() => {});
      },
    );
  await page.goto(request.url);
  if (
    [
      'pending',
      'pending-many',
      'pending-no-session',
      'submitting',
      'decision-expired',
    ].includes(state)
  ) {
    await expectPendingPage(page);
    if (state === 'submitting' || state === 'decision-expired') {
      await duration(page, '1 hour').click();
      if (state === 'decision-expired')
        await age(app, request.id, 'expires_at', 600_000);
      await approveButton(page).click();
      if (state === 'submitting')
        await page
          .getByRole('button', { name: 'Approving for 1 hour…' })
          .waitFor();
      else await page.getByRole('alert').waitFor();
    }
  } else {
    const headings = {
      approved: 'Approved for 1 hour',
      denied: 'Run denied',
      withdrawn: 'The agent cancelled this run',
      expired: 'This request expired',
      settled: 'No longer needed',
    };
    await page
      .getByRole('heading', {
        name: headings[state as keyof typeof headings],
        exact: true,
      })
      .waitFor();
  }
}
it.each(matrix)(
  'E40: capture $state $width $theme from genuine Worker and D1 state',
  async ({ state, width, height, theme }) => {
    const app = await approvalWebApp();
    const ui = await approvalBrowserPage(browser, { width, height });
    const gate = deferred();
    try {
      await setMark(app);
      await setMark(app, cloudflare, 'secret');
      await ui.page.emulateMedia({ colorScheme: theme });
      await openState(ui.page, app, state, gate);
      await expectNoOverflow(ui.page);
      const file = resolve(directory, `${state}-${width}-${theme}`);
      const png = await ui.page.screenshot({
        path: `${file}.png`,
        animations: 'disabled',
      });
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual([
        width,
        height,
      ]);
      if (
        [
          'pending',
          'pending-many',
          'pending-no-session',
          'list',
          'vault-marks',
        ].includes(state)
      )
        await ui.page.screenshot({
          path: `${file}-full.png`,
          animations: 'disabled',
          fullPage: true,
        });
    } finally {
      gate.resolve();
      await ui.close();
      await app.close();
    }
  },
);
