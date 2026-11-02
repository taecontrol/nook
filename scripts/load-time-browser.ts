import { setTimeout as delay } from 'node:timers/promises';
import type { Browser, Page, Request } from 'playwright';
import { memoryId } from '../tests/fixtures/memories.ts';
import { loadTimeBudgets, type Measurements } from './lib/load-time.ts';

export async function phonePage(browser: Browser, kind: string) {
  const context = await browser.newContext({
    ...([
      'authorize',
      'machines',
      'machinesNavigation',
      'approvalNavigation',
      'machineAccessNavigation',
      'audit',
      'auditNavigation',
      'memory',
      'memoryNavigation',
      'memoryReader',
      'memoryReaderNavigation',
    ].includes(kind)
      ? { viewport: { width: 390, height: 844 } }
      : {}),
  });
  const page = await context.newPage();
  recordPage(page);
  page.setDefaultTimeout(15_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', loadTimeBudgets.network);
  return { context, page };
}
type PageRecord = { pending: Map<Request, number>; errors: string[] };
const pageRecords = new WeakMap<Page, PageRecord>();
const withEvidence = new WeakSet<Error>();
// The page may be too busy to answer; that is evidence too.
const pageStateTimeout = 2_000;

// Records, from the moment the page opens, what a failure report needs:
// unfinished requests and the errors the page reported. It keeps URLs and
// error text only, never request or response headers or bodies.
function recordPage(page: Page) {
  const known = pageRecords.get(page);
  if (known) return known;
  const record: PageRecord = { pending: new Map(), errors: [] };
  const ended = (request: Request) => record.pending.delete(request);
  const clip = (text: string) => text.replaceAll(/\s+/g, ' ').slice(0, 500);
  page.on('request', (request) => record.pending.set(request, Date.now()));
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  page.on('pageerror', (error) =>
    record.errors.push(`page error: ${clip(error.message)}`),
  );
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const { url } = message.location();
    record.errors.push(
      `console error: ${clip(message.text())}${url ? ` (${url})` : ''}`,
    );
  });
  pageRecords.set(page, record);
  return record;
}
async function describePage(page: Page, { pending, errors }: PageRecord) {
  const now = Date.now();
  const requests = [...pending].map(
    ([request, since]) =>
      `${request.method()} ${request.url()}, pending for ${now - since} ms`,
  );
  const answered = new AbortController();
  const state = await Promise.race([
    page
      .evaluate(() => {
        const root = document.querySelector('#root');
        return {
          readyState: document.readyState,
          root: !root
            ? 'missing'
            : root.childElementCount
              ? 'rendered'
              : 'empty',
        };
      })
      .then(({ readyState, root }) => [
        `document.readyState: ${readyState}`,
        `#root: ${root}`,
      ]),
    delay(pageStateTimeout, undefined, { signal: answered.signal }).then(() => [
      `The page did not answer within ${pageStateTimeout} ms.`,
    ]),
  ])
    .catch((error: Error) => [`The page state is unreadable: ${error.message}`])
    .finally(() => answered.abort());
  const list = (items: string[]) =>
    items.length ? items.map((item) => `\n    ${item}`).join('') : ' none';
  return [
    'Page evidence:',
    ...state.map((line) => `  ${line}`),
    `  Pending requests:${list(requests)}`,
    `  Page and console errors:${list(errors)}`,
  ].join('\n');
}
// Runs a step against the page and appends the page evidence to its failure,
// once, so a timeout says whether the page waited on the network or itself.
export async function withPageEvidence<T>(
  page: Page,
  action: () => Promise<T>,
): Promise<T> {
  const record = recordPage(page);
  try {
    return await action();
  } catch (error) {
    if (!(error instanceof Error) || withEvidence.has(error)) throw error;
    withEvidence.add(error);
    // V8 formats the stack lazily: read it before the message changes.
    const { message, stack } = error;
    error.message = `${message}\n\n${await describePage(page, record)}`;
    error.stack = stack?.replace(message, error.message);
    throw error;
  }
}
type ColdScreen =
  | 'home'
  | 'buckets'
  | 'authorize'
  | 'machines'
  | 'vault'
  | 'audit'
  | 'memory'
  | 'memoryReader';
function markFirstScreen(kind: ColdScreen) {
  const selectors = {
    buckets: '[aria-label="All buckets"] [data-path]',
    authorize: '#authorization-code',
    machines: '[data-machine]',
    audit: '[data-entry]',
    memory: '[data-memory-row]',
    memoryReader:
      '[data-memory-reading] [data-memory-files][aria-label="Files, 1"]',
    home: '',
    vault: '',
  };
  const observer = new MutationObserver(() => {
    const ready =
      kind === 'home'
        ? document
            .querySelector('[aria-label="Owner access"]')
            ?.textContent?.includes('owner@nook.test')
        : kind === 'vault'
          ? document.querySelector('[data-secret="work/acme/STRIPE_KEY"]') &&
            document
              .querySelector('[aria-label="Buckets"] [data-path="work/acme"]')
              ?.textContent?.includes('4 secrets')
          : document.querySelector(selectors[kind]);
    if (!ready) return;
    observer.disconnect();
    requestAnimationFrame(() =>
      requestAnimationFrame(() => performance.mark('nook-first-screen')),
    );
  });
  observer.observe(document, {
    childList: true,
    subtree: true,
    characterData: true,
  });
}
async function cold(page: Page, origin: string, kind: ColdScreen) {
  await page.addInitScript(markFirstScreen, kind);
  const paths = {
    home: '/',
    buckets: '/buckets',
    authorize: '/cli/authorize',
    machines: '/machines',
    vault: '/vault?bucket=work/acme',
    audit: '/audit',
    memory: '/memory?bucket=work/acme',
    memoryReader: `/memory?bucket=work/acme&memory=${memoryId(100)}`,
  };
  await page.goto(origin + paths[kind]);
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-first-screen').length > 0,
  );
  return page.evaluate(
    () => performance.getEntriesByName('nook-first-screen')[0].startTime,
  );
}
async function approvalNavigation(page: Page, origin: string, code: string) {
  await page.goto(`${origin}/cli/authorize`);
  await page
    .getByRole('textbox', { name: 'Code from your terminal' })
    .waitFor();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    const resources = new PerformanceObserver((entries) => {
      const lookup = entries
        .getEntries()
        .find((entry) => entry.name.includes('/api/authorizations/'));
      if (!(lookup instanceof PerformanceResourceTiming)) return;
      performance.mark('nook-code-accepted', { startTime: lookup.responseEnd });
      resources.disconnect();
    });
    resources.observe({ type: 'resource' });
    const observer = new MutationObserver(() => {
      const row = document.querySelector('[data-grant-path="me"] > div');
      const outline = row
        ?.closest('[aria-label="Bucket access"]')
        ?.getBoundingClientRect();
      if (!row || !outline) return;
      const box = row.getBoundingClientRect();
      if (
        !(
          Math.min(box.width, box.height) > 0 &&
          box.top >= Math.max(0, outline.top) &&
          box.bottom <= Math.min(innerHeight, outline.bottom) &&
          box.left >= Math.max(0, outline.left) &&
          box.right <= Math.min(innerWidth, outline.right)
        )
      )
        return;
      observer.disconnect();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => performance.mark('nook-tree-shown')),
      );
    });
    observer.observe(document, { childList: true, subtree: true });
  });
  await page
    .getByRole('textbox', { name: 'Code from your terminal' })
    .fill(code);
  await page.getByRole('button', { name: 'Continue', exact: true }).click();
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-tree-shown').length > 0,
  );
  return page.evaluate(
    () =>
      performance.measure(
        'nook-approval-tree',
        'nook-code-accepted',
        'nook-tree-shown',
      ).duration,
  );
}
// Measurement scripts wait this long for intent preloading to go quiet.
const intentPreloadTimeout = 15_000;
export type MeasureOptions = { preloadTimeout?: number };

async function settleNetworkAfter<T>(
  page: Page,
  timeout: number,
  action: () => Promise<T>,
) {
  const active = new Set<Request>();
  let quietTimer: ReturnType<typeof setTimeout> | undefined;
  let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
  let finish: (() => void) | undefined;
  const restartQuietWindow = () => {
    clearTimeout(quietTimer);
    if (active.size === 0 && finish) quietTimer = setTimeout(finish, 500);
  };
  const started = (request: Request) => {
    active.add(request);
    clearTimeout(quietTimer);
  };
  const ended = (request: Request) => {
    if (active.delete(request)) restartQuietWindow();
  };
  page.on('request', started);
  page.on('requestfinished', ended);
  page.on('requestfailed', ended);
  try {
    const result = await action();
    await new Promise<void>((resolve, reject) => {
      finish = resolve;
      timeoutTimer = setTimeout(
        () =>
          reject(
            new Error('Intent preload did not reach 500 ms of network quiet.'),
          ),
        timeout,
      );
      restartQuietWindow();
    });
    return result;
  } finally {
    page.off('request', started);
    page.off('requestfinished', ended);
    page.off('requestfailed', ended);
    clearTimeout(quietTimer);
    clearTimeout(timeoutTimer);
  }
}
async function navigate(
  page: Page,
  origin: string,
  kind: 'buckets' | 'machines' | 'vault' | 'audit' | 'memory' | 'memoryReader',
  preloadTimeout: number,
) {
  const link = await settleNetworkAfter(page, preloadTimeout, async () => {
    if (kind === 'memoryReader') {
      await page.goto(`${origin}/memory?bucket=work/acme`);
      const link = page.locator(`[data-memory-row="${memoryId(100)}"]`);
      await link.hover();
      return link;
    }
    await page.goto(origin);
    await page.getByRole('heading', { name: "You're signed in" }).waitFor();
    const link = page
      .getByRole('region', {
        name: ['vault', 'memory'].includes(kind) ? 'Tools' : 'Platform',
      })
      .getByRole('link', {
        name: new RegExp(
          {
            buckets: 'Buckets',
            machines: 'Machines',
            vault: 'Vault',
            audit: 'Audit',
            memory: 'Memory',
          }[kind],
        ),
      });
    await link.hover();
    return link;
  });
  await page.evaluate(
    (selector) => {
      document.addEventListener(
        'click',
        () => performance.mark('nook-navigation-start'),
        { once: true, capture: true },
      );
      const observer = new MutationObserver(() => {
        if (!document.querySelector(selector)) return;
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => performance.mark('nook-navigation-end')),
        );
      });
      observer.observe(document, { childList: true, subtree: true });
    },
    {
      buckets: '[aria-label="All buckets"] [data-path]',
      vault: '[data-secret="me/GITHUB_TOKEN"]',
      machines: '[data-machine]',
      audit: '[data-entry]',
      memory: '[aria-label="Memory buckets"] [data-path="me"]',
      memoryReader:
        '[data-memory-reading] [data-memory-files][aria-label="Files, 1"]',
    }[kind],
  );
  await link.click();
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-navigation-end').length > 0,
  );
  return page.evaluate(
    () =>
      performance.measure(
        'nook-navigation',
        'nook-navigation-start',
        'nook-navigation-end',
      ).duration,
  );
}
async function machineAccessNavigation(
  page: Page,
  origin: string,
  preloadTimeout: number,
) {
  const edit = await settleNetworkAfter(page, preloadTimeout, async () => {
    await page.goto(`${origin}/machines`);
    const button = page
      .getByRole('button', { name: /^Edit access of / })
      .first();
    await button.waitFor();
    await button.hover();
    return button;
  });
  await page.evaluate(() => {
    document.addEventListener(
      'click',
      () => {
        performance.mark('nook-access-start');
        const shown = () => {
          const tree = document.querySelector(
            '[data-slot="sheet-content"][data-state="open"] [aria-label="Bucket access"]',
          );
          const row = tree?.querySelector('[data-grant-path="me"] > div');
          const checked = tree?.querySelector(
            '[role="checkbox"][aria-checked="true"]',
          );
          const box = row?.getBoundingClientRect();
          if (
            !box ||
            !checked ||
            box.left < 0 ||
            box.right > innerWidth ||
            box.top < 0 ||
            box.bottom > innerHeight
          ) {
            requestAnimationFrame(shown);
            return;
          }
          requestAnimationFrame(() =>
            requestAnimationFrame(() => performance.mark('nook-access-shown')),
          );
        };
        requestAnimationFrame(shown);
      },
      { once: true, capture: true },
    );
  });
  await edit.click();
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-access-shown').length > 0,
  );
  return page.evaluate(
    () =>
      performance.measure(
        'nook-access-tree',
        'nook-access-start',
        'nook-access-shown',
      ).duration,
  );
}
export async function measureScreen(
  page: Page,
  origin: string,
  code: string,
  kind: Exclude<keyof Measurements, 'gzipBytes'>,
  { preloadTimeout = intentPreloadTimeout }: MeasureOptions = {},
) {
  const destinations = {
    navigation: 'buckets',
    machinesNavigation: 'machines',
    vaultNavigation: 'vault',
    auditNavigation: 'audit',
    memoryNavigation: 'memory',
    memoryReaderNavigation: 'memoryReader',
  } as const;
  const destination = destinations[kind as keyof typeof destinations];
  return withPageEvidence(page, () => {
    if (kind === 'approvalNavigation')
      return approvalNavigation(page, origin, code);
    if (kind === 'machineAccessNavigation')
      return machineAccessNavigation(page, origin, preloadTimeout);
    return destination
      ? navigate(page, origin, destination, preloadTimeout)
      : cold(page, origin, kind as ColdScreen);
  });
}
