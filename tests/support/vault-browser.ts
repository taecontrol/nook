import type { Browser, Page } from 'playwright';
import { closeBrowserPage } from './buckets-browser.ts';
import { seedSecrets, vaultRuntime } from './vault.ts';

export const secretRow = (page: Page, path: string) =>
  page.locator(`[data-secret="${path}"]`);
export async function vaultPage(
  browser: Browser,
  options: {
    seeds?: readonly (readonly string[])[];
    fresh?: boolean;
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (
      page: Page,
      app: Awaited<ReturnType<typeof vaultRuntime>>,
    ) => Promise<void>;
  } = {},
) {
  const app = await vaultRuntime();
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
    if (options.fresh)
      await (await app.mf.getD1Database('DB'))
        .prepare("DELETE FROM buckets WHERE path <> 'me'")
        .run();
    const values = await seedSecrets(app, options.fresh ? [] : options.seeds);
    await options.configure?.(page, app);
    await page.goto(app.origin + (options.start ?? '/vault?bucket=work/acme'));
    return { page, app, context, requests, values, close };
  } catch (error) {
    await close();
    throw error;
  }
}
export async function createDraft(
  page: Page,
  options: { name?: string; description?: string; value?: string } = {},
) {
  await page.getByRole('button', { name: 'New secret', exact: true }).click();
  const sheet = page.getByRole('dialog');
  await sheet
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill(options.name ?? 'RESEND_API_KEY');
  await sheet
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill(options.description ?? 'Transactional email for staging');
  await sheet
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill(options.value ?? 'synthetic-browser-vault-value');
  return sheet;
}
export async function openSecretMenu(
  page: Page,
  path: string,
  action: 'Replace value…' | 'Delete secret…',
) {
  await secretRow(page, path)
    .getByRole('button', { name: `Actions for ${path}`, exact: true })
    .click();
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
export async function replaceDraft(page: Page, path = 'work/acme/STRIPE_KEY') {
  await openSecretMenu(page, path, 'Replace value…');
  const sheet = page.getByRole('dialog');
  await sheet
    .getByRole('textbox', { name: 'New value', exact: true })
    .fill('synthetic-browser-replacement');
  await sheet
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Replacement description');
  await sheet
    .getByRole('button', { name: 'Replace value…', exact: true })
    .click();
}
export async function privateClientState(
  page: Page,
  values: readonly string[],
) {
  return page.evaluate(
    (privateValues) => {
      const element = document.querySelector('#root > *');
      const key = Object.keys(element ?? {}).find((entry) =>
        entry.startsWith('__reactFiber$'),
      );
      type Fiber = {
        return?: Fiber;
        memoizedProps?: {
          client?: {
            getQueryCache(): { getAll(): unknown[] };
            getMutationCache(): { getAll(): unknown[] };
          };
        };
      };
      let fiber = key
        ? (element as unknown as Record<string, Fiber>)[key]
        : undefined;
      while (fiber) {
        const client = fiber.memoizedProps?.client;
        if (client?.getQueryCache) {
          const cache = JSON.stringify({
            queries: client
              .getQueryCache()
              .getAll()
              .map((entry) => (entry as { state: unknown }).state),
            mutations: client
              .getMutationCache()
              .getAll()
              .map((entry) => (entry as { state: unknown }).state),
          });
          const dom = `${document.documentElement.innerHTML} ${Array.from(
            document.querySelectorAll('textarea, input'),
          )
            .map((input) => (input as HTMLInputElement).value)
            .join(' ')}`;
          return {
            found: true,
            absentFromCache: privateValues.every(
              (value) => !cache.includes(value),
            ),
            absentFromDom: privateValues.every((value) => !dom.includes(value)),
          };
        }
        fiber = fiber.return;
      }
      return { found: false, absentFromCache: false, absentFromDom: false };
    },
    [...values],
  );
}
