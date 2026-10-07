import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { observe } from '../../scripts/observation.ts';

test('E9: the synthetic owner opens Nook and sees their identity', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await expect(screen.getByRole('heading')).toHaveText("You're signed in");
  await expect(screen.getByText('owner@nook.test').first()).toBeVisible();
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E13: the owner creates work/acme inside work', async ({
  app,
  agent,
  screen,
  browser,
}) => {
  await app.open('/');
  await expect(screen.getByRole('heading')).toHaveText("You're signed in");
  await screen.getByRole('link', { name: 'Buckets', exact: true }).click();
  await expect(
    screen.getByRole('heading', { name: 'Buckets', exact: true }),
  ).toBeVisible();
  await agent.act(
    'Create the bucket work/acme using the New bucket path field.',
  );
  await expect(
    browser
      .locator('li[data-bucket="work"] ul [data-path="work/acme"]')
      .getByText('acme', { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole('button', {
      name: 'Actions for work/acme',
      exact: true,
    }),
  ).toBeVisible();
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E24: the owner stores a secret in Vault and sees only its metadata', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await screen.getByRole('link', { name: 'Buckets', exact: true }).click();
  await screen
    .getByRole('textbox', { name: 'New bucket path' })
    .fill('work/vault-journey');
  await screen.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    screen.getByRole('button', {
      name: 'Actions for work/vault-journey',
      exact: true,
    }),
  ).toBeVisible();
  await screen.getByRole('link', { name: 'Vault', exact: true }).click();
  await browser
    .locator('[data-path="work/vault-journey"]')
    .getByRole('link')
    .click();
  await screen.getByRole('button', { name: 'New secret', exact: true }).click();
  const sheet = screen.getByRole('dialog');
  await sheet
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('JOURNEY_KEY');
  await sheet
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Synthetic owner journey');
  await sheet
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill('synthetic-owner-journey-value');
  await sheet.getByRole('button', { name: 'Save secret', exact: true }).click();
  await expect(screen.getByRole('alert')).toContainText('Stored');
  await expect(
    browser.locator('[data-secret="work/vault-journey/JOURNEY_KEY"]'),
  ).toContainText('Synthetic owner journey');
  const privateValueAbsent = await browser.evaluate(() =>
    JSON.stringify(
      !document.documentElement.innerHTML.includes(
        'synthetic-owner-journey-value',
      ),
    ),
  );
  if (privateValueAbsent !== 'true')
    throw new Error('The settled journey must retain metadata only.');
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});
