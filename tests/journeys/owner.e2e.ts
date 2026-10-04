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
