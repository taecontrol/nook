import type { Browser, BrowserContext, Page } from 'playwright';
import { observe } from '../../scripts/observation.ts';

export const typicalBuckets = [
  ['me', '2026-09-12'],
  ['personal', '2026-09-14'],
  ['personal/finances', '2026-09-14'],
  ['personal/health', '2026-09-20'],
  ['work', '2026-09-12'],
  ['work/taecontrol', '2026-09-15'],
  ['work/taecontrol/nook', '2026-10-03'],
].map(([path, date]) => ({ path, createdAt: `${date}T08:00:00.000Z` }));
export const deepBuckets = [
  ...typicalBuckets,
  ...[
    'work/taecontrol/clients',
    'work/taecontrol/clients/municipal-water-authority-ops-mx',
    'work/taecontrol/clients/municipal-water-authority-ops-mx/infrastructure',
    'work/taecontrol/clients/municipal-water-authority-ops-mx/infrastructure/terraform-state-backups',
    'work/clients-and-partners-archive-19',
    'personal/finances/taxes',
    'personal/finances/taxes/2025',
    'personal/finances/taxes/2026',
    'personal/house',
    'personal/house/renovation',
    'side-projects',
    'side-projects/money',
    'side-projects/manuvra',
    'side-projects/memorable',
  ].map((path) => ({ path, createdAt: '2026-10-03T08:00:00.000Z' })),
];
export async function closeBrowserPage(page: Page, context: BrowserContext) {
  if (process.env.COVERAGE_RUN)
    await observe(
      await page.evaluate(() => ({
        seam: 'browser',
        loaded: globalThis.__authoredModules__ ?? {},
        counters: globalThis.__coverage__ ?? {},
      })),
    );
  await context.close();
}
export async function bucketPage(
  browser: Browser,
  origin: string,
  options: {
    start?: string;
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    buckets?: typeof typicalBuckets;
    loadStatus?: number;
  } = {},
) {
  const context = await browser.newContext({
    viewport: options.viewport ?? { width: 1440, height: 900 },
    colorScheme: options.colorScheme ?? 'light',
  });
  const page = await context.newPage();
  const requests: { method: string; url: string }[] = [];
  page.on('request', (request) =>
    requests.push({ method: request.method(), url: request.url() }),
  );
  await page.route('**/api/whoami', (route) =>
    route.fulfill({ json: { email: 'owner@nook.test' } }),
  );
  let release = () => {};
  const pending = new Promise<void>((accept) => {
    release = accept;
  });
  await page.route('**/api/buckets', async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    if (options.loadStatus === 0) {
      await pending;
      return route.abort().catch(() => {});
    }
    return route.fulfill({
      status: options.loadStatus ?? 200,
      json: options.loadStatus
        ? { _tag: 'ServiceUnavailable' }
        : { buckets: options.buckets ?? typicalBuckets },
    });
  });
  await page.goto(origin + (options.start ?? '/buckets'));
  return { page, context, requests, release };
}
