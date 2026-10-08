import type { Browser, Page } from 'playwright';
import { auditNow, seedAudit } from './audit.ts';
import { closeBrowserPage } from './buckets-browser.ts';
import { vaultRuntime } from './vault.ts';
export async function visitAudit(
  browser: Browser,
  options: {
    count?: number;
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (
      page: Page,
      app: Awaited<ReturnType<typeof vaultRuntime>>,
      seeded: Awaited<ReturnType<typeof seedAudit>>,
    ) => Promise<void>;
  } = {},
) {
  const app = await vaultRuntime();
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
    locale: 'en-US',
    timezoneId: 'America/Argentina/Buenos_Aires',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const requests: string[] = [];
  page.on('request', (request) => {
    if (new URL(request.url()).pathname.startsWith('/api/'))
      requests.push(
        new URL(request.url()).pathname + new URL(request.url()).search,
      );
  });
  const close = async () => {
    try {
      await closeBrowserPage(page, context);
    } finally {
      await app.close();
    }
  };
  try {
    const seeded = await seedAudit(app, options.count ?? 30);
    await page.clock.setFixedTime(auditNow);
    await options.configure?.(page, app, seeded);
    await page.goto(app.origin + (options.start ?? '/audit'));
    return { page, app, context, requests, ...seeded, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export const auditEntries = (page: Page) => page.locator('[data-entry]');
export async function selectAudit(page: Page, label: string, value: string) {
  await page.getByRole('combobox', { name: label, exact: true }).click();
  await page.getByRole('option', { name: value, exact: true }).click();
}
