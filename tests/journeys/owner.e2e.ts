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
