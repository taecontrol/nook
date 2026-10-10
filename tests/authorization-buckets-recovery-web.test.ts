import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { bucketCheck, grantPage } from './support/grant-browser.ts';
import { deferred } from './support/machines.ts';

let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('authorization recovery from a rejected optimistic grant preserves the pending bucket creation', async () => {
  const gate = deferred();
  const started = deferred();
  const path = 'work/pending-approval';
  let gets = 0;
  let finishedGets = 0;
  let writes = 0;
  const visit = await grantPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (
          new URL(request.url()).pathname === '/api/buckets' &&
          request.method() === 'GET'
        )
          gets++;
      });
      page.on('requestfinished', (request) => {
        if (
          new URL(request.url()).pathname === '/api/buckets' &&
          request.method() === 'GET'
        )
          finishedGets++;
      });
      await page.route('**/api/buckets**', async (route) => {
        if (route.request().method() === 'POST') {
          writes++;
          started.resolve();
          // Approval reaches the real Worker while this creation is still held.
          await gate.promise;
        }
        await route.continue();
      });
    },
  });
  const { page, reveal, approvals } = visit;
  try {
    await page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .waitFor();
    await page.getByRole('link', { name: 'Back to Nook', exact: true }).click();
    await page.getByRole('link', { name: 'Buckets', exact: true }).click();
    await page.locator('[data-path="work"]').waitFor();
    const field = page.getByRole('textbox', {
      name: 'New bucket path',
      exact: true,
    });
    await field.fill(path);
    await field.press('Enter');
    await started.promise;
    await expect
      .poll(() => page.locator(`[data-path="${path}"]`).count())
      .toBe(1);
    const initial = gets;
    await page.goBack();
    await expect.poll(() => new URL(page.url()).pathname).toBe('/');
    await page.goBack();
    await reveal();
    await bucketCheck(page, path).check();
    await bucketCheck(page, 'me').uncheck();
    const rejected = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/approve'),
    );
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    const failure = await rejected;
    expect(failure.status()).toBe(400);
    expect(await failure.json()).toMatchObject({ _tag: 'GrantBucketNotFound' });
    expect(approvals).toEqual([{ machineName: 'omarchy', grant: [path] }]);
    await page.getByText(/selected buckets.*choose again/i).waitFor();
    await page.evaluate(
      () =>
        new Promise((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(resolve)),
        ),
    );
    await expect.poll(() => finishedGets === gets).toBe(true);
    await expect
      .poll(async () => ({
        gets,
        bucketCount: await bucketCheck(page, path).count(),
      }))
      .toEqual({ gets: initial, bucketCount: 1 });
    expect(await bucketCheck(page, path).isChecked()).toBe(true);
    expect(writes).toBe(1);
    const finished = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/buckets' &&
        response.request().method() === 'POST',
    );
    const recovered = page.waitForResponse(
      (response) =>
        new URL(response.url()).pathname === '/api/buckets' &&
        response.request().method() === 'GET',
    );
    gate.resolve();
    expect((await finished).status()).toBe(200);
    expect((await recovered).status()).toBe(200);
    expect(gets).toBe(initial + 1);
    expect(await bucketCheck(page, path).isChecked()).toBe(true);
    const approved = page.waitForResponse((response) =>
      new URL(response.url()).pathname.endsWith('/approve'),
    );
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    expect((await approved).status()).toBe(204);
    expect(approvals).toEqual([
      { machineName: 'omarchy', grant: [path] },
      { machineName: 'omarchy', grant: [path] },
    ]);
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(writes).toBe(1);
  } finally {
    gate.resolve();
    try {
      await page.unrouteAll({ behavior: 'wait' });
    } finally {
      await visit.close();
    }
  }
});
