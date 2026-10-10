import type { Browser, Page } from 'playwright';
import { loadTimeBudgets, type Measurements } from './lib/load-time.ts';

export async function phonePage(browser: Browser, kind: string) {
  const context = await browser.newContext({
    ...([
      'authorize',
      'machines',
      'machinesNavigation',
      'approvalNavigation',
      'audit',
      'auditNavigation',
      'memory',
      'memoryNavigation',
    ].includes(kind)
      ? { viewport: { width: 390, height: 844 } }
      : {}),
  });
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', loadTimeBudgets.network);
  return { context, page };
}
type ColdScreen =
  | 'home'
  | 'buckets'
  | 'authorize'
  | 'machines'
  | 'vault'
  | 'audit'
  | 'memory';
function markFirstScreen(kind: ColdScreen) {
  const selectors = {
    buckets: '[aria-label="All buckets"] [data-path]',
    authorize: '#authorization-code',
    machines: '[data-machine]',
    audit: '[data-entry]',
    memory: '[data-memory-row]',
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
async function navigate(
  page: Page,
  origin: string,
  kind: 'buckets' | 'machines' | 'vault' | 'audit' | 'memory',
) {
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
  await page.waitForLoadState('networkidle');
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
export async function measureScreen(
  page: Page,
  origin: string,
  code: string,
  kind: Exclude<keyof Measurements, 'gzipBytes'>,
) {
  const destinations = {
    navigation: 'buckets',
    machinesNavigation: 'machines',
    vaultNavigation: 'vault',
    auditNavigation: 'audit',
    memoryNavigation: 'memory',
  } as const;
  const destination = destinations[kind as keyof typeof destinations];
  if (kind === 'approvalNavigation')
    return approvalNavigation(page, origin, code);
  return destination
    ? navigate(page, origin, destination)
    : cold(page, origin, kind as ColdScreen);
}
