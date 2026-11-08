import type { Page } from 'playwright';
import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  approve,
  createAuthorization,
  jsonRequest,
  ownerRuntime,
} from './support/authorizations.ts';
import { closeBrowserPage } from './support/buckets-browser.ts';
import { expectNoOverflow } from './support/page-checks.ts';
import { runtime } from './support/runtime.ts';

async function fixture() {
  const app = await ownerRuntime(await runtime());
  const { browser, close: closeBrowser } = await launchTestBrowser();
  const context = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const page = await context.newPage();
  await page.goto(`${app.origin}/cli/authorize`);
  await page
    .getByRole('textbox', { name: 'Code from your terminal' })
    .waitFor();
  return {
    app,
    page,
    close: async () => {
      await closeBrowserPage(page, context);
      await closeBrowser();
      await app.close();
    },
  };
}
// The phone page never scrolls sideways and the brand keeps room for its
// focus ring.
async function expectFits(page: Page) {
  await expectNoOverflow(page);
  const brand = await page
    .getByRole('link', { name: 'Nook', exact: true })
    .boundingBox();
  if (!brand) throw new Error('The Nook brand must be visible.');
  expect(brand.x, 'Brand focus ring fits the left edge').toBeGreaterThanOrEqual(
    4,
  );
  expect(
    brand.x + brand.width + 4,
    'Brand focus ring fits the right edge',
  ).toBeLessThanOrEqual(390);
}
async function reveal(page: Page, userCode: string) {
  await page
    .getByRole('textbox', { name: 'Code from your terminal' })
    .fill(userCode);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
}
it('Change rechecks a request resolved in another session', async () => {
  const { app, page, close } = await fixture();
  try {
    const authorization = await createAuthorization(app);
    await reveal(page, authorization.userCode);
    await page
      .getByRole('textbox', { name: 'Machine name', exact: true })
      .waitFor();
    await page.getByRole('button', { name: 'Change', exact: true }).click();
    expect((await approve(app, authorization.userCode)).status).toBe(204);
    await reveal(page, authorization.userCode);
    await expect
      .poll(
        () =>
          page
            .getByRole('heading', {
              name: 'This request was already handled',
              exact: true,
            })
            .count(),
        { timeout: 5000 },
      )
      .toBe(1);
    await expectFits(page);
  } finally {
    await close();
  }
});
it('a revealed request expires automatically while the owner considers it', async () => {
  const { app, page, close } = await fixture();
  try {
    const authorization = await createAuthorization(app);
    await (await app.mf.getD1Database('DB'))
      .prepare('UPDATE authorizations SET expires_at=?')
      .bind(Date.now() + 3000)
      .run();
    await reveal(page, authorization.userCode);
    await page
      .getByRole('textbox', { name: 'Machine name', exact: true })
      .waitFor();
    await expect
      .poll(
        () =>
          page
            .getByRole('heading', { name: 'This request expired', exact: true })
            .count(),
        { timeout: 5000 },
      )
      .toBe(1);
    await expectFits(page);
    expect(await page.locator('form').count()).toBe(0);
  } finally {
    await close();
  }
});
it('a request consumed in another session is not reported as a network failure', async () => {
  const { app, page, close } = await fixture();
  try {
    const authorization = await createAuthorization(app);
    await reveal(page, authorization.userCode);
    await page
      .getByRole('textbox', { name: 'Machine name', exact: true })
      .waitFor();
    expect((await approve(app, authorization.userCode)).status).toBe(204);
    expect(
      (
        await jsonRequest(app, '/api/machine/token', {
          deviceCode: authorization.deviceCode,
        })
      ).status,
    ).toBe(200);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await expect
      .poll(
        () =>
          page
            .getByRole('textbox', { name: 'Code from your terminal' })
            .count(),
        { timeout: 5000 },
      )
      .toBe(1);
    await expectFits(page);
    expect(
      await page.getByText('No matching request', { exact: true }).count(),
    ).toBe(1);
    expect(
      await page.getByText("Couldn't reach Nook", { exact: true }).count(),
    ).toBe(0);
  } finally {
    await close();
  }
});
it('a new lookup never reuses a pending response from an abandoned attempt', async () => {
  const { app, page, close } = await fixture();
  let release = () => {};
  try {
    const authorization = await createAuthorization(app);
    let ready = () => {};
    const held = new Promise<void>((accept) => {
      release = accept;
    });
    const fetched = new Promise<void>((accept) => {
      ready = accept;
    });
    let lookups = 0;
    await page.route('**/api/authorizations/*', async (route) => {
      if (++lookups !== 1) return route.continue();
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      ready();
      await held;
      await route.fulfill({ response }).catch(() => {});
    });
    await reveal(page, authorization.userCode);
    await fetched;
    await page.getByRole('link', { name: 'Back to Nook', exact: true }).click();
    await page
      .getByRole('heading', { name: "You're signed in", exact: true })
      .waitFor();
    expect((await approve(app, authorization.userCode)).status).toBe(204);
    await page.goBack();
    await page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .waitFor();
    await reveal(page, authorization.userCode);
    release();
    await expect
      .poll(() =>
        page
          .getByRole('heading', {
            name: 'This request was already handled',
            exact: true,
          })
          .count(),
      )
      .toBe(1);
    await expectFits(page);
    expect(lookups).toBe(2);
  } finally {
    release();
    await close();
  }
});
it('a failed lookup can retry without treating a connection failure as an unknown code', async () => {
  const { app, page, close } = await fixture();
  try {
    const authorization = await createAuthorization(app);
    await page.route('**/api/authorizations/*', (route) => route.abort());
    await reveal(page, authorization.userCode);
    await page.getByText("Couldn't reach Nook", { exact: true }).waitFor();
    await expectFits(page);
    expect(
      await page.getByText('No matching request', { exact: true }).count(),
    ).toBe(0);
    expect(
      await page
        .getByRole('textbox', { name: 'Code from your terminal' })
        .isEnabled(),
    ).toBe(true);
    await page.unroute('**/api/authorizations/*');
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    await page
      .getByRole('textbox', { name: 'Machine name', exact: true })
      .waitFor();
  } finally {
    await close();
  }
});
it('a failed denial retries with an empty name while explicit approval still requires a valid name', async () => {
  const { app, page, close } = await fixture();
  try {
    const authorization = await createAuthorization(app);
    await reveal(page, authorization.userCode);
    const name = page.getByRole('textbox', {
      name: 'Machine name',
      exact: true,
    });
    await name.waitFor();
    await name.fill('');
    const pattern = '**/api/authorizations/*/deny';
    await page.route(pattern, (route) =>
      route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
    );
    await page.getByRole('button', { name: 'Deny', exact: true }).click();
    await page.getByText("Couldn't reach Nook", { exact: true }).waitFor();
    await expectFits(page);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    expect(
      await page
        .getByText('Enter a name for this machine.', { exact: true })
        .count(),
    ).toBe(1);
    await expectFits(page);
    await page.unroute(pattern);
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page
      .getByRole('heading', { name: 'Request denied', exact: true })
      .waitFor();
    await expectFits(page);
    const row = await (await app.mf.getD1Database('DB'))
      .prepare('SELECT status FROM authorizations')
      .first();
    expect(row?.status === 'denied').toBe(true);
  } finally {
    await close();
  }
});
it.each([
  { first: 'deny', second: 'approve' },
  { first: 'approve', second: 'deny' },
] as const)(
  'retry follows the explicit $second choice after a failed $first',
  async ({ first, second }) => {
    const { app, page, close } = await fixture();
    try {
      const authorization = await createAuthorization(app);
      await reveal(page, authorization.userCode);
      await page
        .getByRole('textbox', { name: 'Machine name', exact: true })
        .waitFor();
      const patterns = [
        '**/api/authorizations/*/approve',
        '**/api/authorizations/*/deny',
      ];
      for (const pattern of patterns)
        await page.route(pattern, (route) =>
          route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
        );
      const labels = { approve: 'Approve', deny: 'Deny' };
      await page
        .getByRole('button', { name: labels[first], exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Try again', exact: true })
        .waitFor();
      await page
        .getByRole('button', { name: labels[second], exact: true })
        .click();
      await page
        .getByRole('button', { name: 'Try again', exact: true })
        .waitFor();
      for (const pattern of patterns) await page.unroute(pattern);
      await page
        .getByRole('button', { name: 'Try again', exact: true })
        .click();
      await page
        .getByRole('heading', { name: /Machine approved|Request denied/ })
        .waitFor();
      await expectFits(page);
      const row = await (await app.mf.getD1Database('DB'))
        .prepare('SELECT status FROM authorizations')
        .first();
      expect(
        row?.status === (second === 'approve' ? 'approved' : 'denied'),
        'A retry preserves the latest explicit decision',
      ).toBe(true);
    } finally {
      await close();
    }
  },
);
