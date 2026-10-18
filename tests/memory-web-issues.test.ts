import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import { memoryClient, memoryPage, memoryRows } from './support/memory.ts';
import {
  confirmForget,
  forgetDialog,
  forgetPage,
  forgottenId,
  openForget,
  uniqueTerm,
} from './support/memory-forget.ts';
import { createDraft, vaultPage } from './support/vault-browser.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(() => closeBrowser?.());

const unconfirmed = (page: Page) =>
  page.getByRole('alert').filter({ hasText: 'Forget not confirmed' });

it('#60: an unconfirmed forget survives a visit to Vault and Check again resolves it', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', async (route) => {
      expect((await route.fetch()).status()).toBe(204);
      await route.abort();
    });
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.abort(),
    );
    await confirmForget(page);
    await unconfirmed(page).waitFor();
    await page.getByRole('link', { name: 'Vault', exact: true }).click();
    await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
    await page.goBack();
    await unconfirmed(page).waitFor();
    await page.unroute(`**/api/memories/${forgottenId}`);
    await unconfirmed(page)
      .getByRole('button', { name: 'Check again' })
      .click();
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
    expect(await unconfirmed(page).count()).toBe(0);
    expect(
      await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});

it('#61: a 503 forget remains unconfirmed until an explicit outcome check', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } }),
    );
    await confirmForget(page);
    await unconfirmed(page).waitFor();
    expect(await unconfirmed(page).innerText()).toContain(
      'Nook is unavailable right now.',
    );
    expect(await unconfirmed(page).innerText()).not.toContain(
      'Nothing was deleted',
    );
    await unconfirmed(page)
      .getByRole('button', { name: 'Check again' })
      .click();
    await page.getByText('Not forgotten', { exact: true }).waitFor();
    expect(
      await page.locator(`[data-memory-row="${forgottenId}"]`).count(),
    ).toBe(1);
  } finally {
    await visit.close();
  }
});

it('#61: an unconfirmed Vault write includes the shared failure reason', async () => {
  const visit = await vaultPage(browser);
  try {
    const { page } = visit;
    const draft = await createDraft(page);
    await page.route('**/api/secrets', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        : route.continue(),
    );
    await draft
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
    const alert = page
      .getByRole('alert')
      .filter({ hasText: 'Write unconfirmed' });
    await alert.waitFor();
    expect(await alert.innerText()).toContain('Nook is unavailable right now.');
  } finally {
    await visit.close();
  }
});

it('#61: an unconfirmed bucket write includes the shared failure reason', async () => {
  const visit = await vaultPage(browser, { start: '/buckets' });
  try {
    const { page } = visit;
    await page
      .getByRole('button', { name: 'Actions for work', exact: true })
      .waitFor();
    await page.route('**/api/buckets', (route) =>
      route.request().method() === 'POST'
        ? route.fulfill({ status: 503, json: { _tag: 'ServiceUnavailable' } })
        : route.continue(),
    );
    const field = page.getByRole('textbox', { name: 'New bucket path' });
    await field.fill('work/feedback-target');
    await field.press('Enter');
    const alert = page
      .getByRole('alert')
      .filter({ hasText: "Couldn't confirm creation of work/feedback-target" });
    await alert.waitFor();
    expect(await alert.innerText()).toContain('Nook is unavailable right now.');
  } finally {
    await visit.close();
  }
});

it.each([
  { status: 401, reason: 'Your owner session expired' },
  { status: 403, reason: 'Only this installation’s owner can' },
])(
  '#63: an Access $status forget rejection is definitive',
  async ({ status, reason }) => {
    const visit = await forgetPage(browser);
    const recovery = deferred();
    try {
      const { page } = visit;
      await openForget(page);
      await page.route(`**/api/memories/${forgottenId}`, async (route) => {
        await recovery.promise;
        await route.fulfill({ status, body: 'Access denied' }).catch(() => {});
      });
      await page.route('**/api/memories/*?expectedVersion=*', (route) =>
        route.fulfill({ status, body: 'Access denied' }),
      );
      await confirmForget(page);
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Not forgotten' });
      await alert.waitFor();
      expect(await alert.innerText()).toContain(reason);
      expect(await unconfirmed(page).count()).toBe(0);
    } finally {
      recovery.resolve();
      await visit.close();
    }
  },
);

it.each([
  { status: 401, reason: 'Your owner session expired' },
  { status: 403, reason: 'Only this installation’s owner can' },
])(
  '#63: an Access $status Vault rejection is shown once without retrying',
  async ({ status, reason }) => {
    const visit = await vaultPage(browser);
    try {
      const { page } = visit;
      const draft = await createDraft(page);
      let writes = 0;
      await page.route('**/api/secrets', (route) => {
        if (route.request().method() !== 'POST') return route.continue();
        writes++;
        return route.fulfill({ status, body: 'Access denied' });
      });
      await draft
        .getByRole('button', { name: 'Save secret', exact: true })
        .click();
      const alert = page
        .getByRole('alert')
        .filter({ hasText: 'Couldn’t save secret' });
      await alert.waitFor();
      expect(await alert.innerText()).toContain(reason);
      expect(await alert.innerText()).not.toContain('could not confirm');
      expect(writes).toBe(1);
    } finally {
      await visit.close();
    }
  },
);

it.each(['search', 'counts', 'buckets', 'version'] as const)(
  '#63: the %s load failure explains an expired session',
  async (surface) => {
    const start =
      surface === 'search' || surface === 'version'
        ? `/memory?bucket=work/acme&q=${uniqueTerm}`
        : '/memory?bucket=work/acme';
    const visit = await forgetPage(browser, {
      start,
      configure: async (page) => {
        const path = {
          search: '**/api/memories/search?*',
          counts: '**/api/memories/counts',
          buckets: '**/api/buckets',
          version: `**/api/memories/${forgottenId}`,
        }[surface];
        await page.route(path, (route) =>
          route.fulfill({ status: 401, body: 'Sign in' }),
        );
      },
    });
    try {
      const { page } = visit;
      if (surface === 'version') await openForget(page, forgottenId);
      const container =
        surface === 'version' ? forgetDialog(page) : page.locator('main');
      await expect
        .poll(() => container.innerText())
        .toContain('Your owner session expired');
    } finally {
      await visit.close();
    }
  },
);

it('#63: a failed Check again explains the failure and remains retryable', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page } = visit;
    await openForget(page);
    await page.route('**/api/memories/*?expectedVersion=*', (route) =>
      route.abort(),
    );
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.abort(),
    );
    await confirmForget(page);
    await unconfirmed(page).waitFor();
    await page.unroute(`**/api/memories/${forgottenId}`);
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.fulfill({ status: 401, body: 'Sign in' }),
    );
    await unconfirmed(page)
      .getByRole('button', { name: 'Check again' })
      .click();
    await expect
      .poll(() =>
        page
          .getByRole('alert')
          .filter({ hasText: 'Could not check this memory' })
          .innerText(),
      )
      .toContain('Your owner session expired');
    expect(
      await unconfirmed(page)
        .getByRole('button', { name: 'Check again' })
        .isEnabled(),
    ).toBe(true);
  } finally {
    await visit.close();
  }
});

it('#63: a failed Refresh memory explains the failure and remains retryable', async () => {
  const visit = await forgetPage(browser);
  try {
    const { page, app } = visit;
    await openForget(page);
    const changed = await memoryClient(app, '2026-07-28').call('update', {
      id: forgottenId,
      expectedVersion: 3,
      content: '# Release process\nChanged elsewhere.',
    });
    expect(changed.isError).not.toBe(true);
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.fulfill({ status: 503, body: 'Unavailable' }),
    );
    await confirmForget(page);
    const refresh = page.getByRole('button', {
      name: 'Refresh memory',
      exact: true,
    });
    await refresh.waitFor();
    await page.unroute(`**/api/memories/${forgottenId}`);
    await page.route(`**/api/memories/${forgottenId}`, (route) =>
      route.fulfill({ status: 401, body: 'Sign in' }),
    );
    await refresh.click();
    await expect
      .poll(() =>
        page
          .getByRole('alert')
          .filter({ hasText: 'Could not check this memory' })
          .innerText(),
      )
      .toContain('Your owner session expired');
    expect(await refresh.isEnabled()).toBe(true);
  } finally {
    await visit.close();
  }
});

it('#63: changing scope before the debounce keeps the newly typed query', async () => {
  const visit = await memoryPage(browser);
  try {
    const { page } = visit;
    await memoryRows(page).first().waitFor();
    await page.clock.install();
    await page.clock.pauseAt(new Date(Date.now() + 1000));
    const field = page.getByRole('textbox', {
      name: 'Search memories visible in work/acme',
    });
    await field.fill('release');
    await page
      .getByRole('button', { name: 'Only this bucket', exact: true })
      .click();
    await expect
      .poll(() => new URL(page.url()).searchParams.get('q'))
      .toBe('release');
    await page.clock.resume();
    expect(await field.inputValue()).toBe('release');
    expect(new URL(page.url()).searchParams.get('scope')).toBe('bucket');
  } finally {
    await visit.close();
  }
});

it('#63: a row forget uses the newer version already learned by detail', async () => {
  const visit = await memoryPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    const { page, app } = visit;
    await memoryRows(page).first().waitFor();
    const client = memoryClient(app, '2026-07-28');
    const read = await client.call('get', { id: forgottenId });
    const current = read.structuredContent as { content: string };
    const changed = await client.call('update', {
      id: forgottenId,
      expectedVersion: 1,
      content: `${current.content}\nNew version.`,
    });
    expect(changed.isError).not.toBe(true);
    await page.locator(`[data-memory-row="${forgottenId}"]`).click();
    const detail = page.getByRole('article', { name: 'Memory detail' });
    await detail.getByText('New version.').waitFor();
    await detail.getByRole('link', { name: 'Memories', exact: true }).click();
    await openForget(page, forgottenId);
    expect(await forgetDialog(page).innerText()).toContain(
      'You are forgetting version 2',
    );
    const deleted = page.waitForRequest(
      (request) => request.method() === 'DELETE',
    );
    await confirmForget(page);
    expect(
      new URL((await deleted).url()).searchParams.get('expectedVersion'),
    ).toBe('2');
    await page.getByText('Forgot Release process', { exact: true }).waitFor();
  } finally {
    await visit.close();
  }
});
