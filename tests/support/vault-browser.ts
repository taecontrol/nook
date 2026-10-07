import { Redacted } from 'effect';
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
  // JSON hides live Redacted values. Find their brand through the public predicate
  // and inspect retained state before serialization as well.
  const brand = Object.getOwnPropertyNames(
    Object.getPrototypeOf(Redacted.make('synthetic-probe')),
  ).find((key) => Redacted.isRedacted({ [key]: true }));
  if (!brand) throw new Error('Cannot inspect redacted client values.');
  return page.evaluate(
    ({ privateValues, brand }) => {
      const element = document.querySelector('#root > *');
      const key = Object.keys(element ?? {}).find((entry) =>
        entry.startsWith('__reactFiber$'),
      );
      type Hook = {
        memoizedState?: { current?: unknown };
        next?: Hook;
      };
      type Fiber = {
        return?: Fiber;
        child?: Fiber;
        sibling?: Fiber;
        memoizedState?: Hook;
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
          const refs: unknown[] = [];
          const collectRefs = (node: Fiber | undefined) => {
            if (!node) return;
            let hook = node.memoizedState;
            while (hook) {
              const value = hook.memoizedState?.current;
              if (value !== undefined) refs.push(value);
              hook = hook.next;
            }
            collectRefs(node.child);
            collectRefs(node.sibling);
          };
          collectRefs(fiber.child);
          const retained = {
            queries: client
              .getQueryCache()
              .getAll()
              .map((entry) => (entry as { state: unknown }).state),
            mutations: client
              .getMutationCache()
              .getAll()
              .map((entry) => (entry as { state: unknown }).state),
          };
          const seen = new WeakSet<object>();
          const containsValue = (value: unknown): boolean => {
            if (typeof value === 'string')
              return privateValues.some((secret) => value.includes(secret));
            if (!value || typeof value !== 'object' || seen.has(value))
              return false;
            seen.add(value);
            if (value instanceof Node) return false;
            if (brand in value) return true;
            if (value instanceof Map)
              return Array.from(value.values()).some(containsValue);
            return Object.getOwnPropertyNames(value).some((key) =>
              containsValue((value as Record<string, unknown>)[key]),
            );
          };
          const cache = JSON.stringify(retained);
          const dom = `${document.documentElement.innerHTML} ${Array.from(
            document.querySelectorAll('textarea, input'),
          )
            .map((input) => (input as HTMLInputElement).value)
            .join(' ')}`;
          return {
            found: true,
            absentFromCache:
              !containsValue(retained) &&
              !containsValue(refs) &&
              privateValues.every((value) => !cache.includes(value)),
            absentFromDom: privateValues.every((value) => !dom.includes(value)),
          };
        }
        fiber = fiber.return;
      }
      return { found: false, absentFromCache: false, absentFromDom: false };
    },
    { privateValues: [...values], brand },
  );
}
