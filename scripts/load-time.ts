import type { Browser, Page } from 'playwright';
import { runtime } from '../tests/support/runtime.ts';
import { startHostIsolation } from './lib/host-isolation.ts';
import {
  assertLoadTimes,
  formatMeasurements,
  loadTimeBudgets,
  type Measurements,
  measureInitialJs,
} from './lib/load-time.ts';
import { launchTestBrowser } from './lib/test-browser.ts';

async function phonePage(browser: Browser, kind: string) {
  const context = await browser.newContext({
    ...(['authorize', 'machines', 'machinesNavigation'].includes(kind)
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
type ColdScreen = 'home' | 'buckets' | 'authorize' | 'machines';
function markFirstScreen(kind: ColdScreen) {
  const observer = new MutationObserver(() => {
    const ready =
      kind === 'authorize'
        ? document.querySelector('#authorization-code')
        : kind === 'home'
          ? document
              .querySelector('[aria-label="Owner access"]')
              ?.textContent?.includes('owner@nook.test')
          : document.querySelector(
              kind === 'machines'
                ? '[data-machine]'
                : '[aria-label="All buckets"] [data-path]',
            );
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
  };
  await page.goto(origin + paths[kind]);
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-first-screen').length > 0,
  );
  return page.evaluate(
    () => performance.getEntriesByName('nook-first-screen')[0].startTime,
  );
}
async function navigate(
  page: Page,
  origin: string,
  kind: 'buckets' | 'machines',
) {
  await page.goto(origin);
  await page.getByRole('heading', { name: "You're signed in" }).waitFor();
  const link = page
    .getByRole('region', { name: 'Platform' })
    .getByRole('link', {
      name: new RegExp(kind === 'buckets' ? 'Buckets' : 'Machines'),
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
    kind === 'buckets'
      ? '[aria-label="All buckets"] [data-path]'
      : '[data-machine]',
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
const isolation = await startHostIsolation();
try {
  const app = await runtime({ directory: 'dist' });
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      'INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at, id) VALUES (?, ?, ?, ?, ?)',
    )
    .bind(
      'synthetic-load-time-hash',
      'load-time-machine',
      '"all"',
      Date.now(),
      'synthetic-load-time-id',
    )
    .run();
  const { browser, close: closeBrowser } = await launchTestBrowser();
  try {
    const measured: Measurements = {
      home: [],
      buckets: [],
      navigation: [],
      authorize: [],
      machines: [],
      machinesNavigation: [],
      gzipBytes: (await measureInitialJs('dist/assets')).gzipBytes,
    };
    for (const kind of [
      'home',
      'buckets',
      'authorize',
      'navigation',
      'machines',
      'machinesNavigation',
    ] as const) {
      for (let run = 0; run < loadTimeBudgets.runs; run++) {
        const { context, page } = await phonePage(browser, kind);
        try {
          measured[kind].push(
            await (kind === 'navigation' || kind === 'machinesNavigation'
              ? navigate(
                  page,
                  app.origin,
                  kind === 'navigation' ? 'buckets' : 'machines',
                )
              : cold(page, app.origin, kind)),
          );
        } finally {
          await context.close();
        }
      }
    }
    console.log(formatMeasurements(measured));
    assertLoadTimes(measured);
  } finally {
    await closeBrowser();
    await app.close();
  }
} finally {
  await isolation.close();
}
