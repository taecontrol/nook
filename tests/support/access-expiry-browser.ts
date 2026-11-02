import type { Browser, Page } from 'playwright';
import { dayMs, expiryColumns } from './access-expiry.ts';
import { machinesPage } from './machines-browser.ts';
import type { TestRuntime } from './runtime.ts';

export async function expiryFixtures(page: Page, app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  await expiryColumns(db);
  const now = (await db
    .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now")
    .first<{ now: number }>())!.now;
  await db
    .prepare(
      "UPDATE machine_tokens SET created_at=CAST(unixepoch('subsec')*1000 AS INTEGER)-86400000*5, last_used_at=CAST(unixepoch('subsec')*1000 AS INTEGER)-600000",
    )
    .run();
  for (const [name, offset] of [
    ['expired-sandbox', -dayMs],
    ['never-expiring', null],
    ['short-lived', 3_600_000],
    ['dated-machine', 30 * dayMs],
  ] as const)
    await db
      .prepare(
        "UPDATE machine_tokens SET access_expires_at=CASE WHEN ?1 IS NULL THEN NULL ELSE CAST(unixepoch('subsec')*1000 AS INTEGER)+?1 END WHERE machine_name=?2",
      )
      .bind(offset, name)
      .run();
  await page.clock.setFixedTime(new Date(now));
  return now;
}
export function expiryPage(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    colorScheme?: 'light' | 'dark';
    configure?: (page: Page, app: TestRuntime, now: number) => Promise<void>;
  } = {},
) {
  return machinesPage(browser, {
    seeds: [
      'expired-sandbox',
      'never-expiring',
      'short-lived',
      'dated-machine',
    ].map((name) => ({
      name,
      approvedAt: '2026-10-01T12:00:00.000Z',
      lastUsedAt: '2026-10-02T12:00:00.000Z',
    })),
    viewport: options.viewport,
    colorScheme: options.colorScheme,
    configure: async (page, app) => {
      const now = await expiryFixtures(page, app);
      await options.configure?.(page, app, now);
    },
  });
}
