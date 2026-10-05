import type { Browser, Page } from 'playwright';
import { ownerRuntime } from './authorizations.ts';
import { closeBrowserPage } from './buckets-browser.ts';
import {
  type MachineSeed,
  machinesNow,
  seedMachines,
  typicalMachines,
} from './machines.ts';
import { runtime, type TestRuntime } from './runtime.ts';

export const machineRow = (page: Page, id: string) =>
  page.locator(`[data-machine="${id}"]`);
export async function machinesPage(
  browser: Browser,
  options: {
    seeds?: readonly MachineSeed[];
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  const app = await ownerRuntime(await runtime());
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const requests: { method: string; path: string }[] = [];
  page.on('request', (request) =>
    requests.push({
      method: request.method(),
      path: new URL(request.url()).pathname,
    }),
  );
  const close = async () => {
    try {
      await closeBrowserPage(page, context);
    } finally {
      await app.close();
    }
  };
  try {
    const machines = await seedMachines(app, options.seeds ?? typicalMachines);
    await page.clock.install({ time: new Date(machinesNow) });
    await page.clock.setFixedTime(new Date(machinesNow));
    await options.configure?.(page, app);
    await page.goto(app.origin + (options.start ?? '/machines'));
    return { page, app, context, machines, requests, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function confirmRevoke(page: Page, id: string) {
  await machineRow(page, id)
    .getByRole('button', { name: /Revoke/ })
    .click();
  await page
    .getByRole('alertdialog')
    .getByRole('button', { name: 'Revoke machine', exact: true })
    .click();
}
