import type { Browser, Page } from 'playwright';
import { createAuthorization, ownerRuntime } from './authorizations.ts';
import { closeBrowserPage } from './buckets-browser.ts';
import { seedGrantTree } from './grants.ts';
import { runtime, type TestRuntime } from './runtime.ts';

export async function grantPage(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  const app = await ownerRuntime(await runtime());
  await seedGrantTree(app);
  const pending = await createAuthorization(app, 'omarchy');
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(3000);
  const approvals: unknown[] = [];
  page.on('request', (request) => {
    if (request.url().endsWith('/approve'))
      approvals.push(request.postDataJSON());
  });
  const close = async () => {
    try {
      await closeBrowserPage(page, context);
    } finally {
      await app.close();
    }
  };
  try {
    await options.configure?.(page, app);
    await page.goto(`${app.origin}/cli/authorize`);
    const reveal = async () => {
      await page
        .getByRole('textbox', { name: 'Code from your terminal' })
        .fill(pending.userCode);
      await page.getByRole('button', { name: 'Continue', exact: true }).click();
      await page
        .getByRole('textbox', { name: 'Machine name', exact: true })
        .waitFor();
    };
    return { app, page, pending, approvals, reveal, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export const bucketCheck = (page: Page, path: string) =>
  page.getByRole('checkbox', { name: path, exact: true });
export async function selectDeep(page: Page) {
  await bucketCheck(page, 'me').uncheck();
  await bucketCheck(page, 'work/acme').check();
}
