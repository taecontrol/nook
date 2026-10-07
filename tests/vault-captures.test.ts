import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { deferred } from './support/machines.ts';
import type { vaultRuntime } from './support/vault.ts';
import {
  createDraft,
  openSecretMenu,
  replaceDraft,
  secretRow,
  vaultPage,
} from './support/vault-browser.ts';
import { manyVaultSeeds } from './support/vault-captures.ts';

const directory = resolve('.local/verification/screenshots');
let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  await mkdir(directory, { recursive: true });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const states = [
  'typical',
  'fresh',
  'bucket-empty',
  'many-long',
  'loading',
  'load-error',
  'create',
  'create-invalid',
  'create-duplicate',
  'created',
  'replace-confirm',
  'delete-confirm',
  'write-failed',
] as const;
type State = (typeof states)[number];
const matrix = states.flatMap((state) =>
  (['light', 'dark'] as const).flatMap((theme) =>
    [
      { name: 'desktop', width: 1440, height: 900 },
      { name: 'mobile', width: 390, height: 844 },
    ].map((size) => ({ state, theme, size })),
  ),
);

it('E25: capture inventory covers every accepted scenario in both viewports and themes', () => {
  // These profiles and scenario names are the accepted E25 requirements,
  // independently specified from the capture fixture that must realize them.
  const profiles = [
    { width: 1440, height: 900, theme: 'light' },
    { width: 1440, height: 900, theme: 'dark' },
    { width: 390, height: 844, theme: 'light' },
    { width: 390, height: 844, theme: 'dark' },
  ];
  expect(matrix).toHaveLength(52);
  for (const profile of profiles)
    expect(
      matrix
        .filter(
          ({ theme, size }) =>
            theme === profile.theme &&
            size.width === profile.width &&
            size.height === profile.height,
        )
        .map(({ state }) => state)
        .sort(),
    ).toEqual([
      'bucket-empty',
      'create',
      'create-duplicate',
      'create-invalid',
      'created',
      'delete-confirm',
      'fresh',
      'load-error',
      'loading',
      'many-long',
      'replace-confirm',
      'typical',
      'write-failed',
    ]);
});

async function configureState(
  page: Page,
  app: Awaited<ReturnType<typeof vaultRuntime>>,
  state: State,
  gate: ReturnType<typeof deferred>,
) {
  await page.clock.setFixedTime(new Date('2026-10-07T09:41:00Z'));
  if (state === 'write-failed')
    await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
  if (state === 'load-error')
    await (await app.mf.getD1Database('DB'))
      .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
      .run();
  if (state === 'loading')
    await page.route('**/api/secrets', async (route) => {
      await gate.promise;
      await route.continue().catch(() => {});
    });
}
async function ready(page: Page, state: State) {
  await page.getByRole('heading', { name: 'Vault', exact: true }).waitFor();
  if (state === 'loading')
    return page.getByRole('status', { name: 'Loading secrets' }).waitFor();
  if (state === 'load-error')
    return page.getByText('Couldn’t load secrets', { exact: true }).waitFor();
  const create = page
    .getByRole('button', { name: 'New secret', exact: true })
    .first();
  await create.waitFor();
  await expect.poll(() => create.isEnabled()).toBe(true);
}
async function createState(page: Page, state: State) {
  const sheet = await createDraft(page, {
    name:
      state === 'create-invalid'
        ? 'resend_api_key'
        : state === 'create-duplicate'
          ? 'STRIPE_KEY'
          : 'RESEND_API_KEY',
    description:
      state === 'create-duplicate'
        ? 'Stripe live-mode secret key'
        : 'Transactional email for staging',
  });
  if (
    state === 'create-duplicate' ||
    state === 'created' ||
    state === 'write-failed'
  )
    await sheet
      .getByRole('button', { name: 'Save secret', exact: true })
      .click();
  if (state === 'create-invalid')
    await sheet
      .getByText(
        'Use uppercase letters, digits, and underscores, starting with a letter or underscore.',
        { exact: true },
      )
      .waitFor();
  if (state === 'create-duplicate')
    await sheet
      .getByText('work/acme/STRIPE_KEY already exists.', { exact: true })
      .waitFor();
  if (state === 'created') {
    await page
      .getByRole('alert')
      .filter({ has: page.getByText('Secret saved', { exact: true }) })
      .waitFor();
    await secretRow(page, 'work/acme/RESEND_API_KEY').waitFor();
  }
  if (state === 'write-failed') {
    await page
      .getByRole('alert')
      .filter({ hasText: 'Nothing was stored.' })
      .waitFor();
    expect(await secretRow(page, 'work/acme/RESEND_API_KEY').count()).toBe(0);
  }
}
it.each(matrix)(
  'E25: capture $state $size.name $theme from the built Vault product',
  async ({ state, theme, size }) => {
    const gate = deferred();
    const errors: string[] = [];
    const visit = await vaultPage(browser, {
      fresh: state === 'fresh',
      seeds: state === 'many-long' ? manyVaultSeeds : undefined,
      start:
        state === 'typical' || state === 'fresh'
          ? '/vault'
          : `/vault?bucket=${state === 'bucket-empty' ? 'work/globex' : 'work/acme'}`,
      viewport: size,
      colorScheme: theme,
      configure: async (page, app) => {
        page.on('pageerror', (error) => errors.push(error.name));
        await configureState(page, app, state, gate);
      },
    });
    const { page } = visit;
    try {
      await ready(page, state);
      if (state.startsWith('create') || state === 'write-failed')
        await createState(page, state);
      if (state === 'replace-confirm') {
        await replaceDraft(page);
        await page.getByRole('alertdialog').waitFor();
      }
      if (state === 'delete-confirm') {
        await openSecretMenu(page, 'work/acme/DATABASE_URL', 'Delete secret…');
        await page.getByRole('alertdialog').waitFor();
      }
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(size.width);
      expect(
        await page.getByRole('button', { name: /Scenarios|Reset/i }).count(),
      ).toBe(0);
      expect(errors).toEqual([]);
      expect(
        await page.evaluate(
          () => matchMedia('(prefers-color-scheme: dark)').matches,
        ),
      ).toBe(theme === 'dark');
      const filename = `vault-${state}-${size.name}-${theme}`;
      const png = await page.screenshot({
        path: resolve(directory, `${filename}.png`),
        animations: 'disabled',
      });
      expect([png.readUInt32BE(16), png.readUInt32BE(20)]).toEqual(
        size.name === 'desktop' ? [1440, 900] : [390, 844],
      );
      if (state === 'many-long')
        await page.screenshot({
          path: resolve(directory, `${filename}-full.png`),
          animations: 'disabled',
          fullPage: true,
        });
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
