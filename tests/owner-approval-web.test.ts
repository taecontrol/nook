import type { Browser, Page, Response } from 'playwright';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import {
  age,
  ask,
  cloudflare,
  decide,
  mark,
  setMark,
  stripe,
  view,
  withdraw,
} from './support/owner-approval.ts';
import {
  type ApprovalApp,
  approvalBrowserPage,
  approvalNow,
  approvalScope,
  approvalWebApp,
  approveButton,
  duration,
  expectNoDecisionControls,
  expectPendingPage,
  expectSlashBreaks,
  longPurpose,
  purpose,
  session,
  webPending,
} from './support/owner-approval-browser.ts';
import {
  expectNoOverflow,
  expectWithinViewport,
} from './support/page-checks.ts';
import {
  createSecret,
  decryptRow,
  expectNoValue,
  secretInput,
  secretRows,
} from './support/vault.ts';
import { privateClientState } from './support/vault-browser.ts';

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
  await setMark(app);
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

it.each([true, false])(
  'E31: the pending page orders verified facts, unverified purpose, duration, decisions and claimed context (session claim: %s)',
  async (withSession) => {
    const request = await webPending(app, {
      agentSession: withSession ? session : undefined,
    });
    await page.goto(request.url);
    await expectPendingPage(page);
    expect(
      await page
        .getByRole('link', { name: 'All approvals', exact: true })
        .getAttribute('href'),
    ).toBe('/approvals');
    expect(await page.locator('[data-sidebar]').count()).toBe(0);
    const text = await page.locator('body').innerText();
    const ordered = [
      'Verified by Nook',
      'Machine',
      'omarchy',
      stripe,
      'Ask first, from work',
      'Claimed by the agent, not verified',
      purpose,
      'Approve for',
      'Only this time',
      '1 hour',
      '12 hours',
      'Deny',
      'Approve this time',
      'Also claimed by the agent',
      'Executable',
      'pnpm',
      'Working directory',
      '/home/owner/work/acme',
      'Session',
      'Client',
      'nook 0.3.2 · linux-x64',
    ];
    let previous = -1;
    for (const copy of ordered) {
      const index = text
        .toLowerCase()
        .indexOf(copy.toLowerCase(), previous + 1);
      expect(
        index,
        `${copy} follows the preceding fact in the reference's reading order`,
      ).toBeGreaterThan(previous);
      previous = index;
    }
    if (withSession) expect(text).toContain(session.session);
    else expect(text).not.toContain(session.session);
    expect(
      await duration(page, 'Only this time').getAttribute('aria-checked'),
    ).toBe('true');
    for (const copy of [
      'This run',
      'Until 11:42',
      'Until 22:42',
      'Only this run gets the secrets. The next run asks again.',
    ])
      expect(text).toContain(copy);
    await expect
      .poll(() => page.getByText('8:42 left', { exact: true }).count())
      .toBe(1);
    await page.clock.setSystemTime(approvalNow);
    await page.clock.runFor(1000);
    await expect
      .poll(() => page.getByText('8:41 left', { exact: true }).count())
      .toBe(1);
  },
);

it('E32: approving for 1 hour shows Approving for 1 hour… and disables every decision control until the server answers', async () => {
  const request = await webPending(app);
  const gate = deferred();
  const started = deferred();
  await page.route(`**/api/approvals/${request.id}/approve`, async (route) => {
    expect(route.request().postDataJSON()).toEqual({ remember: '1h' });
    started.resolve();
    await gate.promise;
    await route.continue().catch(() => {});
  });
  try {
    await page.goto(request.url);
    await expectPendingPage(page);
    await duration(page, '1 hour').click();
    await page
      .getByRole('button', { name: 'Approve for 1 hour', exact: true })
      .click();
    await started.promise;
    const busy = page.getByRole('button', { name: 'Approving for 1 hour…' });
    await busy.waitFor();
    expect(await busy.isDisabled()).toBe(true);
    expect(
      await page
        .getByRole('button', { name: 'Deny', exact: true })
        .isDisabled(),
    ).toBe(true);
    for (const control of await page.getByRole('radio').all())
      expect(await control.isDisabled()).toBe(true);
    expect(await page.getByRole('radio').count()).toBe(3);
    expect(
      await page
        .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
        .count(),
    ).toBe(0);
    expect(await view(app, request.id)).toMatchObject({ state: 'pending' });
    // Even a browser deadline passing cannot replace a submitting decision.
    await page.clock.setSystemTime(approvalNow);
    await page.clock.runFor(523_000);
    expect(await busy.isDisabled()).toBe(true);
    expect(
      await page
        .getByRole('heading', { name: 'This request expired', exact: true })
        .count(),
    ).toBe(0);
    gate.resolve();
    await page
      .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
      .waitFor();
    expect(await page.locator('body').innerText()).toContain(approvalScope);
    expect(
      await page.getByText('1 hour, until 11:42', { exact: true }).count(),
    ).toBe(1);
    expect(await view(app, request.id)).toMatchObject({
      state: 'approved',
      remember: '1h',
      validUntil: '2026-11-04T11:42:00.000Z',
    });
    await expectNoDecisionControls(page);
  } finally {
    gate.resolve();
  }
});

it('E33: the browser countdown expires without a reload, another document or a decision request', async () => {
  const request = await webPending(app);
  let documents = 0;
  const decisions: string[] = [];
  page.on('request', (r) => {
    if (r.isNavigationRequest()) documents++;
    if (r.method() === 'POST') decisions.push(r.url());
  });
  await page.goto(request.url);
  await expectPendingPage(page);
  const documentIdentity = await page.evaluate(() => {
    const token = crypto.randomUUID();
    document.documentElement.dataset.identity = token;
    return token;
  });
  await page.clock.setSystemTime(approvalNow);
  await page.clock.runFor(521_000);
  expect(await approveButton(page).count()).toBe(1);
  await page.clock.runFor(1000);
  await expect
    .poll(() =>
      page
        .getByRole('heading', { name: 'This request expired', exact: true })
        .count(),
    )
    .toBe(1);
  expect(
    await page.evaluate(() => document.documentElement.dataset.identity),
  ).toBe(documentIdentity);
  expect(documents).toBe(1);
  expect(decisions).toEqual([]);
  expect(await page.getByRole('alert').count()).toBe(0);
  await expectNoDecisionControls(page);
});

it('E33: a server Expired decision shows the expired card and the unsaved 1 hour alert', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  await duration(page, '1 hour').click();
  await age(app, request.id, 'expires_at', 600_000);
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/${request.id}/approve`),
  );
  await approveButton(page).click();
  expect((await answered).status()).toBe(410);
  await page
    .getByRole('heading', { name: 'This request expired', exact: true })
    .waitFor();
  const alert = await page.getByRole('alert').innerText();
  expect(alert).toContain("Your 1 hour approval wasn't saved");
  expect(alert).toContain(
    'The request expired just before your choice reached Nook.',
  );
  await expectNoDecisionControls(page);
});

const states = [
  ['approved', 'Approved for 1 hour', 'This run got its secrets.', '1h'],
  ['approved', /^Approved/, 'Only this time', 'once'],
  ['approved', 'Approved for 12 hours', '22:42', '12h'],
  [
    'denied',
    'Run denied',
    'nook run stopped on omarchy. Nothing was delivered.',
    'deny',
  ],
  [
    'withdrawn',
    'The agent cancelled this run',
    'nook run stopped before you decided. Nothing was delivered, and there is nothing left to do here.',
    'once',
  ],
  [
    'expired',
    'This request expired',
    'Requests last 10 minutes. Nothing was delivered. If the agent still needs these secrets, it runs again and sends a new link.',
    'once',
  ],
  [
    'settled',
    'No longer needed',
    'This run got its secrets without a decision here: an approval you gave earlier covered it, or its secrets are no longer marked Ask first.',
    'once',
  ],
] as const;
async function terminal(
  request: Awaited<ReturnType<typeof webPending>>,
  state: string,
  choice: 'once' | '1h' | '12h' | 'deny',
) {
  if (state === 'approved' || state === 'denied')
    expect((await decide(app, request.id, choice)).status).toBe(200);
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
  expect(await view(app, request.id)).toMatchObject({ state });
}
it.each(states)(
  'E34: opening a %s request (%s) shows its reference state card without decisions',
  async (state, heading, copy, choice) => {
    const request = await webPending(app);
    await terminal(request, state, choice);
    await page.goto(request.url);
    await expect
      .poll(
        () => page.getByRole('heading', { name: heading, exact: true }).count(),
        { message: `The ${state} request renders its state card` },
      )
      .toBe(1);
    expect(await page.locator('body').innerText()).toContain(copy);
    await expectNoDecisionControls(page);
  },
);
it.each(['withdrawn', 'settled'] as const)(
  'E34: AlreadyHandled after the run becomes %s replaces pending actions with the server state',
  async (state) => {
    const request = await webPending(app);
    await page.goto(request.url);
    await expectPendingPage(page);
    await terminal(request, state, 'once');
    const answered = page.waitForResponse((r) =>
      r.url().endsWith(`/${request.id}/approve`),
    );
    await approveButton(page).click();
    expect((await answered).status()).toBe(409);
    const expected = states.find(([key]) => key === state);
    if (!expected) throw new Error('Every terminal state has reference copy.');
    await page
      .getByRole('heading', { name: expected[1], exact: true })
      .waitFor();
    expect(await page.locator('body').innerText()).toContain(expected[2]);
    await expectNoDecisionControls(page);
  },
);

it('E35: three secrets and the long purpose keep Deny and Approve reachable on a 390×844 phone and paths break only at /', async () => {
  await page.setViewportSize({ width: 390, height: 844 });
  await setMark(app, cloudflare, 'secret');
  const longBucket =
    'work/municipal-water-authority-ops-mx/infrastructure/terraform-state-backups';
  await seedGrantTree(app, [longBucket]);
  expect(
    (
      await createSecret(
        app,
        secretInput({ bucket: longBucket, name: 'DATABASE_URL' }),
      )
    ).status,
  ).toBe(201);
  const paths = [stripe, `${longBucket}/DATABASE_URL`, cloudflare];
  const request = await webPending(app, {
    secrets: paths,
    purpose: longPurpose,
  });
  await page.goto(request.url);
  await expectPendingPage(page);
  expect(await page.locator('body').innerText()).toContain(longPurpose);
  expect(
    await page.getByText('Ask first, from work', { exact: true }).count(),
  ).toBe(2);
  expect(
    await page.getByText('Ask first, on this secret', { exact: true }).count(),
  ).toBe(1);
  const purposeElement = page.getByText(`“${longPurpose}”`, { exact: true });
  await expectWithinViewport(approveButton(page));
  await expectWithinViewport(
    page.getByRole('button', { name: 'Deny', exact: true }),
  );
  expect(
    await page.evaluate(() => scrollY),
    'Actions are reachable before any scrolling',
  ).toBe(0);
  let wrapped = 0;
  for (const path of paths) {
    const element = page.getByText(path, { exact: true });
    expect(await element.count()).toBe(1);
    wrapped += (await expectSlashBreaks(element)).length;
  }
  expect(
    wrapped,
    'The long nested path actually wraps on the phone',
  ).toBeGreaterThan(0);
  for (const fraction of [0.25, 0.5, 1]) {
    await page.evaluate(
      (fraction) =>
        window.scrollTo(0, document.documentElement.scrollHeight * fraction),
      fraction,
    );
    await expectWithinViewport(approveButton(page));
    await expectWithinViewport(
      page.getByRole('button', { name: 'Deny', exact: true }),
    );
    await expectNoOverflow(page);
  }
  // The claimed purpose remains in the document; it is not truncated to make room.
  expect(await purposeElement.count()).toBe(1);
});

it.each(['network', '503'] as const)(
  'E43: a %s decision failure restores pending controls and retrying the same 1 hour choice succeeds',
  async (failure) => {
    const request = await webPending(app);
    const bodies: unknown[] = [];
    await page.route(
      `**/api/approvals/${request.id}/approve`,
      async (route) => {
        bodies.push(route.request().postDataJSON());
        if (bodies.length > 1) return route.continue();
        // Lose an actual committed answer: the retry must use the identical choice.
        const committed = await route.fetch();
        expect(committed.status()).toBe(200);
        if (failure === 'network') await route.abort('failed');
        else
          await route.fulfill({
            status: 503,
            json: { _tag: 'ServiceUnavailable' },
          });
      },
    );
    await page.goto(request.url);
    await expectPendingPage(page);
    await duration(page, '1 hour').click();
    await approveButton(page).click();
    await page.getByRole('alert').waitFor();
    expect((await page.getByRole('alert').innerText()).length).toBeGreaterThan(
      0,
    );
    await expectPendingPage(page);
    expect(await approveButton(page).isEnabled()).toBe(true);
    expect(
      await page.getByRole('button', { name: 'Deny', exact: true }).isEnabled(),
    ).toBe(true);
    for (const control of await page.getByRole('radio').all())
      expect(await control.isEnabled()).toBe(true);
    expect(await duration(page, '1 hour').getAttribute('aria-checked')).toBe(
      'true',
    );
    expect(bodies).toEqual([{ remember: '1h' }]);
    expect(await view(app, request.id)).toMatchObject({
      state: 'approved',
      remember: '1h',
    });
    await approveButton(page).click();
    await page
      .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
      .waitFor();
    expect(bodies).toEqual([{ remember: '1h' }, { remember: '1h' }]);
    expect(await page.getByRole('alert').count()).toBe(0);
  },
);

it('E41: approval details, decisions, the approvals list and Vault marks never request, receive or retain a secret value', async () => {
  const input = secretInput({ name: 'PRIVACY_CANARY' });
  expect((await createSecret(app, input)).status).toBe(201);
  const request = await webPending(app, {
    secrets: ['work/acme/PRIVACY_CANARY'],
  });
  const denied = await webPending(app);
  const values = await Promise.all(
    (await secretRows(app)).map((row) => decryptRow(app.key, row)),
  );
  const requests: string[] = [];
  const bodies: Promise<string>[] = [];
  page.on('request', (r) => requests.push(new URL(r.url()).pathname));
  const observeResponse = (response: Response) => {
    if (new URL(response.url()).pathname.startsWith('/api/'))
      bodies.push(response.text());
  };
  page.on('response', observeResponse);
  async function noRetainedValue() {
    expectNoValue(await page.content(), values);
    expect(
      await privateClientState(page, values, { inspectReact: true }),
    ).toEqual({ found: true, absentFromCache: true, absentFromDom: true });
  }
  await page.goto(request.url);
  await expectPendingPage(page);
  await noRetainedValue();
  await page.goto(denied.url);
  await expectPendingPage(page);
  await page.getByRole('button', { name: 'Deny', exact: true }).click();
  await page
    .getByRole('heading', { name: 'Run denied', exact: true })
    .waitFor();
  await noRetainedValue();
  await page.goto(request.url);
  await expectPendingPage(page);
  await duration(page, '1 hour').click();
  await approveButton(page).click();
  await page
    .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
    .waitFor();
  await noRetainedValue();
  await page.getByRole('link', { name: 'All approvals', exact: true }).click();
  await page.getByRole('heading', { name: 'Approvals', exact: true }).waitFor();
  await noRetainedValue();
  await page.getByRole('link', { name: 'Vault', exact: true }).click();
  await page.locator('[data-path="work"] a').click();
  const bucketSwitch = page
    .locator('[data-slot="card"]')
    .filter({ has: page.getByRole('switch', { name: /Ask first/ }) })
    .getByRole('switch');
  for (const method of ['DELETE', 'PUT']) {
    const saved = page.waitForResponse(
      (r) =>
        r.request().method() === method &&
        new URL(r.url()).pathname.startsWith('/api/ask-first/'),
    );
    await bucketSwitch.click();
    expect((await saved).status()).toBe(204);
    await noRetainedValue();
  }
  await page.locator('[data-path="work/acme"] a').click();
  await page.locator('[data-secret="work/acme/PRIVACY_CANARY"]').waitFor();
  await noRetainedValue();
  expect(
    requests.filter((path) => /\/reveal$|\/values$/.test(path)),
    'These surfaces never fetch values',
  ).toEqual([]);
  expect(requests.some((path) => path.startsWith('/api/approvals'))).toBe(true);
  expect(requests).toContain('/api/ask-first');
  await page.waitForLoadState('networkidle');
  page.off('response', observeResponse);
  const encoded = values.map((value) => JSON.stringify(value).slice(1, -1));
  for (const body of await Promise.all(bodies))
    expectNoValue(body, [...values, ...encoded]);
});

it('E34: AlreadyHandled cancels an older pending detail read before refreshing the withdrawn state', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  await page.getByRole('link', { name: 'All approvals', exact: true }).click();
  await page.getByRole('link', { name: 'Review', exact: true }).waitFor();
  await page.clock.setFixedTime(new Date(approvalNow.getTime() + 31_000));
  const old = deferred();
  const read = deferred();
  let reads = 0;
  await page.route(`**/api/approvals/${request.id}`, async (route) => {
    reads++;
    if (reads > 1) return route.continue();
    const response = await route.fetch();
    read.resolve();
    await old.promise;
    await route.fulfill({ response }).catch(() => {});
  });
  try {
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await read.promise;
    await expectPendingPage(page);
    expect((await withdraw(app, app.token, request.id)).status).toBe(204);
    await approveButton(page).click();
    await page
      .getByRole('heading', {
        name: 'The agent cancelled this run',
        exact: true,
      })
      .waitFor();
    expect(reads).toBe(2);
    await expectNoDecisionControls(page);
  } finally {
    old.resolve();
  }
});
