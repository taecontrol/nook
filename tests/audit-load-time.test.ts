import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { measureScreen, phonePage } from '../scripts/load-time-browser.ts';
import {
  acmePath,
  fetchValues,
  timedSession,
  timedUse,
} from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { pending, setMark } from './support/owner-approval.ts';
import { seedSecrets, vaultRuntime } from './support/vault.ts';

type Screen = { url: string; entries: string[] };
type Observed = Window & { marked?: Record<string, Screen> };

let app: Awaited<ReturnType<typeof vaultRuntime>>;
let browser: Browser;
let closeBrowser: (() => Promise<void>) | undefined;
beforeAll(async () => {
  app = await vaultRuntime();
  await seedSecrets(app);
  const { token } = await issueGrant(app);
  const used = await fetchValues(app, token, timedUse);
  expect(used.status).toBe(200);
  await used.body?.cancel();
  await setMark(app);
  await pending(app, token, undefined, { secrets: [acmePath] });
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
  await app?.close();
});

it('auditSessionNavigation stops its clock on the session list of the claimed use on a 390 px phone', async () => {
  const { context, page } = await phonePage(browser, 'auditSessionNavigation');
  try {
    expect(page.viewportSize()).toEqual({ width: 390, height: 844 });
    await page.addInitScript(() => {
      const mark = performance.mark.bind(performance);
      performance.mark = (name, options) => {
        const observed = window as Observed;
        observed.marked = {
          ...observed.marked,
          [name]: {
            url: location.pathname + location.search,
            entries: [...document.querySelectorAll('[data-entry]')].map(
              (entry) => entry.textContent ?? '',
            ),
          },
        };
        return mark(name, options);
      };
    });
    const measured = await measureScreen(
      page,
      app.origin,
      '',
      'auditSessionNavigation',
    );
    expect(Number.isFinite(measured)).toBe(true);
    expect(measured).toBeGreaterThanOrEqual(0);
    const marked = await page.evaluate(() => (window as Observed).marked);
    expect(marked?.['nook-navigation-start'].url).toBe('/audit');
    expect(
      marked?.['nook-navigation-start'].entries.length,
    ).toBeGreaterThanOrEqual(2);
    const atEnd = marked?.['nook-navigation-end'];
    expect(atEnd?.url).toBe(`/audit?session=${timedSession}`);
    expect(atEnd?.entries).toHaveLength(1);
    expect(atEnd?.entries[0]).toContain(timedUse.purpose);
  } finally {
    await context.close();
  }
});
