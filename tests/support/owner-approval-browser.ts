import { randomUUID } from 'node:crypto';
import type { Browser, Locator, Page } from 'playwright';
import { expect } from 'vitest';
import { closeBrowserPage } from './buckets-browser.ts';
import {
  age,
  approvalFixture,
  pending,
  stripe,
  view,
} from './owner-approval.ts';
import { watchPageErrors } from './page-checks.ts';

export const approvalNow = new Date('2026-11-04T10:42:00.000Z');
export const purpose =
  'Deploy acme web to production after the migration passes';
export const longPurpose =
  'Run the production database migration for acme web, then deploy the Worker and purge the CDN cache so customers see the new checkout flow';
export const session = {
  agent: 'claude-code',
  session: 'synthetic-session-42',
};
export const approvalScope =
  'Any later run on omarchy uses this secret without asking until 11:42, whichever agent runs it. Other secrets still ask.';
export type ApprovalApp = Awaited<ReturnType<typeof approvalFixture>>;

export async function approvalWebApp() {
  const app = await approvalFixture(undefined, { now: approvalNow.getTime() });
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('UPDATE machine_tokens SET machine_name=? WHERE id=?')
    .bind('omarchy', app.machine.id)
    .run();
  return app;
}

export async function webPending(
  app: ApprovalApp,
  overrides: Record<string, unknown> = {},
) {
  const attemptId = randomUUID();
  const input = {
    secrets: [stripe],
    purpose,
    executable: 'pnpm',
    workingDirectory: '/home/owner/work/acme',
    agentSession: session,
    ...overrides,
  };
  const request = await pending(app, app.token, attemptId, input);
  expect(
    new URL(request.url).origin,
    'The CLI link targets this fixture Worker',
  ).toBe(app.origin);
  // Defaults are SQLite wall time; move the actual row, never fabricate a view.
  await age(
    app,
    request.id,
    'expires_at',
    Date.parse(request.expiresAt) - approvalNow.getTime() - 522_000,
  );
  await (await app.mf.getD1Database('DB'))
    .prepare('UPDATE approval_requests SET requested_at=?,client=? WHERE id=?')
    .bind(approvalNow.getTime() - 78_000, 'nook 0.3.2 · linux-x64', request.id)
    .run();
  expect(
    await view(app, request.id),
    'A real pending request backs the UI',
  ).toMatchObject({
    state: 'pending',
    claimed: { purpose: input.purpose },
  });
  return { ...request, attemptId, input };
}

export async function approvalBrowserPage(
  browser: Browser,
  viewport = { width: 1440, height: 900 },
  timezoneId = 'UTC',
) {
  const context = await browser.newContext({ viewport, timezoneId });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.install({ time: approvalNow });
  await page.clock.setFixedTime(approvalNow);
  const noErrors = watchPageErrors(page);
  return {
    page,
    context,
    async close() {
      try {
        await closeBrowserPage(page, context);
      } finally {
        noErrors();
      }
    },
  };
}

export async function expectPendingPage(page: Page) {
  await expect
    .poll(
      () =>
        page
          .getByRole('heading', {
            name: 'Approve this run?',
            exact: true,
          })
          .count(),
      { message: 'The approval URL renders the pending decision card' },
    )
    .toBe(1);
}
export const duration = (page: Page, name: string) =>
  page.getByRole('radio', { name: new RegExp(`^${name}(?:\\s|$)`) });
export const approveButton = (page: Page) =>
  page.getByRole('button', {
    name: /^Approve (?:this time|for 1 hour|for 12 hours)$/,
    exact: true,
  });
export async function expectNoDecisionControls(page: Page) {
  expect(await page.getByRole('radio').count()).toBe(0);
  expect(await approveButton(page).count()).toBe(0);
  expect(
    await page.getByRole('button', { name: 'Deny', exact: true }).count(),
  ).toBe(0);
}

// Inspect rendered glyphs across text nodes: a <wbr>, CSS break-all, or nested
// spans must not conceal a line break inside a path segment.
export async function expectSlashBreaks(element: Locator, path?: string) {
  const glyphs = await element.evaluate((element) => {
    const glyphs: { text: string; top: number; width: number }[] = [];
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const text = node.textContent ?? '';
      for (let i = 0; i < text.length; i++) {
        const range = document.createRange();
        range.setStart(node, i);
        range.setEnd(node, i + 1);
        const box = range.getBoundingClientRect();
        glyphs.push({ text: text[i], top: box.top, width: box.width });
      }
    }
    return glyphs;
  });
  // A scope sentence contains prose too; inspect just its path without changing
  // the DOM or requiring the path to already have its own element.
  const start =
    path === undefined
      ? 0
      : glyphs
          .map((g) => g.text)
          .join('')
          .indexOf(path);
  expect(
    start,
    'The rendered element contains the path being checked',
  ).toBeGreaterThanOrEqual(0);
  const visible = glyphs
    .slice(start, path === undefined ? undefined : start + path.length)
    .filter((glyph) => glyph.width > 0);
  const breaks = visible.flatMap((glyph, i) =>
    i && Math.abs(glyph.top - visible[i - 1].top) > 2
      ? [`${visible[i - 1].text}${glyph.text}`]
      : [],
  );
  expect(
    breaks.every((pair) => pair.includes('/')),
    'Rendered paths break only at /, never inside a segment',
  ).toBe(true);
  return breaks;
}
