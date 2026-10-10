import type { Browser } from 'playwright';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
} from '../scripts/lib/load-time.ts';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import { manyMemories, memoryRows, seedMemories } from './support/memory.ts';
import { seedSecrets, vaultRuntime } from './support/vault.ts';

const measured = {
  home: Array(5).fill(500),
  buckets: Array(5).fill(500),
  navigation: Array(5).fill(20),
  authorize: Array(5).fill(500),
  machines: Array(5).fill(500),
  machinesNavigation: Array(5).fill(20),
  approvalNavigation: Array(5).fill(20),
  vault: Array(5).fill(500),
  vaultNavigation: Array(5).fill(20),
  audit: Array(5).fill(500),
  auditNavigation: Array(5).fill(20),
  memory: Array(5).fill(500),
  memoryNavigation: Array(5).fill(20),
};
it.each([
  ['memory', 1001],
  ['memoryNavigation', 101],
] as const)('E31: the %s budget fails independently', (key, value) => {
  expect(() =>
    assertLoadTimes({ ...measured, [key]: Array(5).fill(value) }),
  ).toThrow(/memory/i);
  expect(() => assertLoadTimes({ ...measured, [key]: [] })).toThrow();
});
it('E31: five samples and both Memory medians are mandatory in diagnostics', () => {
  expect(() => assertLoadTimes(measured)).not.toThrow();
  expect(JSON.parse(formatMeasurements(measured)).medianMs).toMatchObject({
    memory: 500,
    memoryNavigation: 20,
  });
});

describe('E31 production measurement conditions', () => {
  let app: Awaited<ReturnType<typeof vaultRuntime>>;
  let browser: Browser;
  let closeBrowser: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    app = await vaultRuntime();
    await seedSecrets(app);
    await seedMemories(app, manyMemories);
    ({ browser, close: closeBrowser } = await launchTestBrowser());
  });
  afterAll(async () => {
    await closeBrowser?.();
    await app?.close();
  });
  it.each(['memory', 'memoryNavigation'] as const)(
    '%s measures the real Memory first screen on a 390 px phone',
    async (kind) => {
      const { context, page } = await phonePage(browser, kind);
      try {
        expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
        const measured = await measureScreen(page, app.origin, '', kind);
        expect(Number.isFinite(measured)).toBe(true);
        expect(measured).toBeGreaterThanOrEqual(0);
        const url = new URL(page.url());
        expect(url.pathname).toBe('/memory');
        if (kind === 'memory') {
          expect(url.searchParams.get('bucket')).toBe('work/acme');
          expect(await memoryRows(page).count()).toBe(25);
          expect(await memoryRows(page).first().isVisible()).toBe(true);
        } else {
          expect(url.searchParams.has('bucket')).toBe(false);
          expect(
            await page
              .getByRole('navigation', { name: 'Memory buckets' })
              .locator('[data-path="me"]')
              .isVisible(),
          ).toBe(true);
        }
      } finally {
        await context.close();
      }
    },
  );
});
