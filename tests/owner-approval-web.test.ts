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
    // The client is reported, so only a missing session reads Not reported.
    if (withSession) {
      expect(text).toContain(session.session);
      expect(text).not.toContain('Not reported');
    } else {
      expect(text).not.toContain(session.session);
      expect(text).toContain('Not reported');
    }
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

const states = [
  ['approved', 'Approved', 'Only this time', 'once'],
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
] as const;
// A settled request is opened through the AlreadyHandled refresh below; the
// cold open and that refresh render the same card from one query.
const settled = [
  'settled',
  'No longer needed',
  'This run got its secrets without a decision here: an approval you gave earlier covered it, or its secrets are no longer marked Ask first.',
  'once',
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
it('E34: AlreadyHandled after the run becomes settled replaces pending actions with the server state', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  await terminal(request, 'settled', 'once');
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/${request.id}/approve`),
  );
  await approveButton(page).click();
  expect((await answered).status()).toBe(409);
  await page.getByRole('heading', { name: settled[1], exact: true }).waitFor();
  expect(await page.locator('body').innerText()).toContain(settled[2]);
  await expectNoDecisionControls(page);
});

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
    await page
      .getByRole('alert')
      .filter({ hasText: "Couldn't confirm your choice" })
      .waitFor();
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

it('E35: long unbroken secret, machine and directory names stay inside the phone while paths still break only at /', async () => {
  const name = 'X'.repeat(64);
  const path = `work/acme/${name}`;
  const machine = `owner-machine-${'m'.repeat(50)}`;
  const workingDirectory = `/home/${'working-directory-claim'.repeat(12)}`;
  expect((await createSecret(app, secretInput({ name }))).status).toBe(201);
  await (await app.mf.getD1Database('DB'))
    .prepare('UPDATE machine_tokens SET machine_name=? WHERE id=?')
    .bind(machine, app.machine.id)
    .run();
  const request = await webPending(app, { secrets: [path], workingDirectory });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(request.url);
  await expectPendingPage(page);
  await expectNoOverflow(page);
  await expectSlashBreaks(page.getByText(path, { exact: true }));
  await expectSlashBreaks(page.getByText(workingDirectory, { exact: true }));
  await duration(page, '1 hour').click();
  await approveButton(page).click();
  await page
    .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
    .waitFor();
  await expectNoOverflow(page);
  await page.getByRole('link', { name: 'All approvals', exact: true }).click();
  await page.getByText(machine, { exact: true }).waitFor();
  await expectNoOverflow(page);
});

// The success path does not depend on the choice; E41 ends a denial.
it('E32/E34: a successful 1 hour decision survives an older pending detail response without returning controls', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  await page.getByRole('link', { name: 'All approvals', exact: true }).click();
  await page.getByRole('link', { name: 'Review', exact: true }).waitFor();
  await page.clock.setFixedTime(new Date(approvalNow.getTime() + 31_000));
  const old = deferred();
  const read = deferred();
  const released = deferred();
  await page.route(`**/api/approvals/${request.id}`, async (route) => {
    const response = await route.fetch();
    expect(await response.json()).toMatchObject({ state: 'pending' });
    read.resolve();
    await old.promise;
    await route.fulfill({ response }).catch(() => {});
    released.resolve();
  });
  try {
    await page.getByRole('link', { name: 'Review', exact: true }).click();
    await read.promise;
    await expectPendingPage(page);
    await duration(page, '1 hour').click();
    await approveButton(page).click();
    const result = page.getByRole('heading', {
      name: 'Approved for 1 hour',
      exact: true,
    });
    await result.waitFor();
    await expectNoDecisionControls(page);
    await page.evaluate(() => {
      document.documentElement.dataset.controlsReturned = 'false';
      new MutationObserver(() => {
        if (document.querySelector('[role="radio"]'))
          document.documentElement.dataset.controlsReturned = 'true';
      }).observe(document, { childList: true, subtree: true });
    });
    old.resolve();
    await released.promise;
    await page.waitForLoadState('networkidle');
    expect(
      await result.count(),
      'An older pending GET cannot undo a confirmed decision',
    ).toBe(1);
    expect(
      await page.evaluate(
        () => document.documentElement.dataset.controlsReturned,
      ),
    ).toBe('false');
    await expectNoDecisionControls(page);
  } finally {
    old.resolve();
  }
});

const longSecretName = 'X'.repeat(64);
const longSecretPath = `work/acme/${longSecretName}`;
it.each([
  { covered: [longSecretPath], scope: `this secret (${longSecretPath})` },
  {
    covered: [stripe, longSecretPath],
    scope: `these secrets (${stripe}, ${longSecretPath})`,
  },
])(
  'E32/E35/E36: a mixed request shows every requested secret but remembers only the covered scope: $scope',
  async ({ covered, scope: coveredScope }) => {
    expect(
      (await createSecret(app, secretInput({ name: longSecretName }))).status,
    ).toBe(201);
    const request = await webPending(app, {
      secrets: [...covered, cloudflare],
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(request.url);
    await expectPendingPage(page);
    const verified = page.getByRole('region', { name: 'Verified by Nook' });
    for (const path of [...covered, cloudflare])
      expect(await verified.getByText(path, { exact: true }).count()).toBe(1);
    expect(await verified.innerText()).toContain('Not marked Ask first');
    await duration(page, '1 hour').click();
    const scope = `Any later run on omarchy uses ${coveredScope} without asking until 11:42, whichever agent runs it. Other secrets still ask.`;
    const pendingScope = page.getByText(scope, { exact: true });
    expect(await pendingScope.count()).toBe(1);
    await expectNoOverflow(page);
    for (const path of covered) await expectSlashBreaks(pendingScope, path);
    await approveButton(page).click();
    await page
      .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
      .waitFor();
    const approvedScope = page.locator('[data-slot="card-description"]');
    expect(await approvedScope.innerText()).toBe(
      `This run got its secrets. ${scope}`,
    );
    await expectNoOverflow(page);
    for (const path of covered) await expectSlashBreaks(approvedScope, path);
    await page
      .getByRole('link', { name: 'All approvals', exact: true })
      .click();
    const remembered = page.locator(`[data-approval="${request.id}"]`);
    await remembered.waitFor();
    for (const path of covered)
      expect(await remembered.innerText()).toContain(path);
    expect(await remembered.innerText()).not.toContain(cloudflare);
  },
);

it('E31/E32: approval end times use the browser time zone in Kolkata', async () => {
  await ui.close();
  ui = await approvalBrowserPage(browser, undefined, 'Asia/Kolkata');
  page = ui.page;
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  expect(await page.getByText('Until 17:12', { exact: true }).count()).toBe(1);
  expect(await page.getByText('Until 04:12', { exact: true }).count()).toBe(1);
  await duration(page, '1 hour').click();
  expect(await page.locator('body').innerText()).toContain(
    'without asking until 17:12',
  );
  await approveButton(page).click();
  await page
    .getByRole('heading', { name: 'Approved for 1 hour', exact: true })
    .waitFor();
  expect(
    await page.getByText('1 hour, until 17:12', { exact: true }).count(),
  ).toBe(1);
  expect(await page.locator('body').innerText()).toContain(
    'without asking until 17:12',
  );
});

it('E34: decision-time NotFound replaces the pending form with its load failure message', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM approval_requests WHERE id=?')
    .bind(request.id)
    .run();
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/${request.id}/approve`),
  );
  await approveButton(page).click();
  expect((await answered).status()).toBe(404);
  await page
    .getByText('This approval request was not found.', { exact: true })
    .waitFor();
  expect(
    await page.getByText('Couldn’t load approval', { exact: true }).count(),
  ).toBe(1);
  await expectNoDecisionControls(page);
  expect(
    await page
      .getByRole('button', { name: 'Try again', exact: true })
      .isEnabled(),
  ).toBe(true);
});

it('E34: AlreadyHandled with a failed recovery load hides stale decisions and retries the terminal state', async () => {
  const request = await webPending(app);
  await page.goto(request.url);
  await expectPendingPage(page);
  expect((await withdraw(app, app.token, request.id)).status).toBe(204);
  await page.route(`**/api/approvals/${request.id}`, (route) =>
    route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
  );
  const answered = page.waitForResponse((r) =>
    r.url().endsWith(`/${request.id}/approve`),
  );
  await approveButton(page).click();
  expect((await answered).status()).toBe(409);
  await page.getByText('Couldn’t load approval', { exact: true }).waitFor();
  expect(await page.locator('body').innerText()).toContain(
    'Try again in a moment.',
  );
  await expectNoDecisionControls(page);
  expect(await page.getByRole('button', { name: /Approving/ }).count()).toBe(0);
  await page.unroute(`**/api/approvals/${request.id}`);
  await page.getByRole('button', { name: 'Try again', exact: true }).click();
  await page
    .getByRole('heading', { name: 'The agent cancelled this run', exact: true })
    .waitFor();
  await expectNoDecisionControls(page);
});
