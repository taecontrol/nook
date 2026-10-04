import { type Browser, chromium, type Page } from 'playwright';
import { runtime } from '../tests/support/runtime.ts';
import {
  assertLoadTimes,
  formatMeasurements,
  loadTimeBudgets,
  type Measurements,
  measureInitialJs,
} from './lib/load-time.ts';

async function phonePage(browser: Browser) {
  const context = await browser.newContext();
  const page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setCacheDisabled', { cacheDisabled: true });
  await cdp.send('Network.emulateNetworkConditions', loadTimeBudgets.network);
  return { context, page };
}
function markFirstScreen(kind: 'home' | 'buckets') {
  const observer = new MutationObserver(() => {
    const ready =
      kind === 'home'
        ? document
            .querySelector('[aria-label="Owner access"]')
            ?.textContent?.includes('owner@nook.test')
        : document.querySelector('[aria-label="All buckets"] [data-path]');
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
async function cold(page: Page, origin: string, kind: 'home' | 'buckets') {
  await page.addInitScript(markFirstScreen, kind);
  await page.goto(origin + (kind === 'home' ? '/' : '/buckets'));
  await page.waitForFunction(
    () => performance.getEntriesByName('nook-first-screen').length > 0,
  );
  return page.evaluate(
    () => performance.getEntriesByName('nook-first-screen')[0].startTime,
  );
}
async function navigate(page: Page, origin: string) {
  await page.goto(origin);
  await page.getByRole('heading', { name: "You're signed in" }).waitFor();
  const link = page.getByRole('link', { name: 'Buckets', exact: true });
  await link.hover();
  await page.waitForLoadState('networkidle');
  await page.evaluate(() => {
    document.addEventListener(
      'click',
      () => performance.mark('nook-navigation-start'),
      { once: true, capture: true },
    );
    const observer = new MutationObserver(() => {
      if (!document.querySelector('[aria-label="All buckets"] [data-path]'))
        return;
      observer.disconnect();
      requestAnimationFrame(() =>
        requestAnimationFrame(() => performance.mark('nook-navigation-end')),
      );
    });
    observer.observe(document, { childList: true, subtree: true });
  });
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
const app = await runtime({ directory: 'dist' });
await app.setBindings({
  LOCAL_OWNER: 'synthetic-owner',
  LOCAL_ORIGIN: app.origin,
});
const browser = await chromium.launch();
try {
  const measured: Measurements = {
    home: [],
    buckets: [],
    navigation: [],
    gzipBytes: (await measureInitialJs('dist/assets')).gzipBytes,
  };
  for (const kind of ['home', 'buckets', 'navigation'] as const) {
    for (let run = 0; run < loadTimeBudgets.runs; run++) {
      const { context, page } = await phonePage(browser);
      try {
        measured[kind].push(
          await (kind === 'navigation'
            ? navigate(page, app.origin)
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
  await browser.close();
  await app.close();
}
