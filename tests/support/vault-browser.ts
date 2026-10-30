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
    app?: Awaited<ReturnType<typeof vaultRuntime>>;
    configure?: (
      page: Page,
      app: Awaited<ReturnType<typeof vaultRuntime>>,
    ) => Promise<void>;
  } = {},
) {
  const app = options.app ?? (await vaultRuntime());
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
  options: { allowRedacted?: boolean; inspectReact?: boolean } = {},
) {
  // JSON hides live Redacted values. Find their brand through the public predicate
  // and inspect retained state before serialization as well.
  const brand = Object.getOwnPropertyNames(
    Object.getPrototypeOf(Redacted.make('synthetic-probe')),
  ).find((key) => Redacted.isRedacted({ [key]: true }));
  if (!brand) throw new Error('Cannot inspect redacted client values.');
  return page.evaluate(
    ({ privateValues, brand, allowRedacted, inspectReact }) => {
      type Client = {
        getQueryCache(): { getAll(): { state: unknown }[] };
        getMutationCache(): { getAll(): { state: unknown }[] };
      };
      type Fiber = {
        return?: Fiber;
        child?: Fiber;
        sibling?: Fiber;
        stateNode?: { current?: Fiber };
        memoizedState?: unknown;
        memoizedProps?: { client?: Client };
      };
      type Hook = { memoizedState?: { current?: unknown }; next?: Hook };
      const refsFrom = (state: unknown) => {
        const refs: unknown[] = [];
        const hooks = new WeakSet<object>();
        let hook = state as Hook | undefined;
        while (hook && !hooks.has(hook)) {
          hooks.add(hook);
          const value = hook.memoizedState?.current;
          if (value !== undefined) refs.push(value);
          hook = hook.next;
        }
        return refs;
      };
      const attachedFiber = (element: Element | null) => {
        const key = Object.keys(element ?? {}).find((entry) =>
          /^__react(Container|Fiber)\$/.test(entry),
        );
        return key
          ? (element as unknown as Record<string, Fiber>)[key]
          : undefined;
      };
      let root =
        attachedFiber(document.querySelector('#root')) ??
        attachedFiber(document.querySelector('#root > *'));
      while (root?.return) root = root.return;
      // The container attachment can point to the initial HostRoot fiber.
      root = root?.stateNode?.current ?? root;
      const react: unknown[] = [];
      const refs: unknown[] = [];
      const fibers = new WeakSet<object>();
      let client: Client | undefined;
      const collectState = (fiber: Fiber | undefined) => {
        if (!fiber || fibers.has(fiber)) return;
        fibers.add(fiber);
        react.push(fiber.memoizedState, fiber.memoizedProps);
        refs.push(...refsFrom(fiber.memoizedState));
        if (fiber.memoizedProps?.client?.getQueryCache)
          client = fiber.memoizedProps.client;
        collectState(fiber.child);
        collectState(fiber.sibling);
      };
      collectState(root);
      if (!client)
        return { found: false, absentFromCache: false, absentFromDom: false };
      const retained = {
        queries: client
          .getQueryCache()
          .getAll()
          .map((entry) => entry.state),
        mutations: client
          .getMutationCache()
          .getAll()
          .map((entry) => entry.state),
      };
      // A metadata UUID can contain a short value such as PORT=4000 by
      // chance. Still detect any complete private value, including a UUID.
      const privateText = (text: string) =>
        /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i.test(
          text,
        ) && !privateValues.includes(text)
          ? ''
          : text;
      const seen = new WeakSet<object>();
      const inspectable = (value: unknown): value is object =>
        !!value &&
        typeof value === 'object' &&
        !seen.has(value) &&
        !(value instanceof Node);
      const fiberLinks = new Set([
        'return',
        'child',
        'sibling',
        'alternate',
        'stateNode',
      ]);
      const isFiber = (value: object) =>
        'tag' in value &&
        typeof value.tag === 'number' &&
        'memoizedState' in value &&
        'memoizedProps' in value &&
        'return' in value;
      const children = (value: object): unknown[] => {
        if (value instanceof Map) return Array.from(value.entries());
        if (value instanceof Set) return Array.from(value.values());
        // Only React fibers own links to skip; ordinary data can use any key.
        const skipLinks = isFiber(value);
        return Object.getOwnPropertyNames(value)
          .filter((key) => !skipLinks || !fiberLinks.has(key))
          .map((key) => (value as Record<string, unknown>)[key]);
      };
      const containsValue = (value: unknown): boolean => {
        if (typeof value === 'string')
          return privateValues.some((secret) =>
            privateText(value).includes(secret),
          );
        if (!inspectable(value)) return false;
        seen.add(value);
        // Redacted is opaque: pending imports may retain it, never its text.
        if (brand in value) return !allowRedacted;
        return children(value).some(containsValue);
      };
      const cache = JSON.stringify(retained, (_key, value) =>
        typeof value === 'string' ? privateText(value) : value,
      );
      const dom = `${document.documentElement.innerHTML} ${Array.from(
        document.querySelectorAll('textarea, input'),
      )
        .map((input) => (input as HTMLInputElement).value)
        .join(' ')}`;
      return {
        found: true,
        absentFromCache:
          !containsValue(retained) &&
          // Reveal intentionally renders values; import Review checks all
          // React state and props in addition to the existing cache/ref guard.
          !containsValue(inspectReact ? react : refs) &&
          privateValues.every((value) => !cache.includes(value)),
        absentFromDom: privateValues.every((value) => !dom.includes(value)),
      };
    },
    {
      privateValues: [...values],
      brand,
      allowRedacted: options.allowRedacted,
      inspectReact: options.inspectReact,
    },
  );
}
