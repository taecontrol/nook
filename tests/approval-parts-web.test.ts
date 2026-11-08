import { expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { setMark } from './support/owner-approval.ts';
import {
  approvalBrowserPage,
  approvalWebApp,
  expectPendingPage,
  webPending,
} from './support/owner-approval-browser.ts';

it('approval and authorization cards render identical mark and command wrappers', async () => {
  const { browser, close } = await launchTestBrowser();
  const app = await approvalWebApp();
  const ui = await approvalBrowserPage(browser);
  try {
    await setMark(app);
    const request = await webPending(app);
    await ui.page.goto(request.url);
    await expectPendingPage(ui.page);
    const mark = ui.page.locator(
      '[data-slot="card-header"] [data-slot="avatar"]',
    );
    const approvalMark = await mark.evaluate((element) => {
      const copy = element.cloneNode(true) as Element;
      copy.querySelector('svg')?.replaceWith(document.createElement('svg'));
      return copy.outerHTML;
    });
    const approvalCmd = await ui.page
      .locator('code')
      .filter({ hasText: 'nook run' })
      .evaluate((element) => element.outerHTML.replace('nook run', 'command'));
    await ui.page.goto(`${app.origin}/cli/authorize`);
    await ui.page
      .getByRole('heading', { name: 'Enter the code from your terminal' })
      .waitFor();
    expect(
      await mark.evaluate((element) => {
        const copy = element.cloneNode(true) as Element;
        copy.querySelector('svg')?.replaceWith(document.createElement('svg'));
        return copy.outerHTML;
      }),
    ).toBe(approvalMark);
    expect(
      await ui.page
        .locator('code')
        .filter({ hasText: 'nook login' })
        .evaluate((element) =>
          element.outerHTML.replace('nook login', 'command'),
        ),
    ).toBe(approvalCmd);
  } finally {
    await ui.close();
    await app.close();
    await close();
  }
});
