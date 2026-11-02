import type { Browser, Page } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { d1Now, dayMs, lifetimes } from './support/access-expiry.ts';
import { expiryPage } from './support/access-expiry-browser.ts';
import { jsonRequest } from './support/authorizations.ts';
import { grantPage } from './support/grant-browser.ts';
import { seedGrantTree } from './support/grants.ts';
import { deferred, listMachines, machineIdentity } from './support/machines.ts';
import { machineRow } from './support/machines-browser.ts';
import { expectNoOverflow } from './support/page-checks.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const dateTime = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
const date = (iso: string) =>
  new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric',
    year: 'numeric',
  }).format(new Date(iso));
async function expiresRow(page: Page) {
  return page
    .locator('dl > div')
    .filter({ has: page.locator('dt').getByText('Expires', { exact: true }) })
    .locator('dd')
    .innerText();
}
it('Expiry E1: approval offers all five lifetimes, defaults to 30 days and distinguishes request expiry', async () => {
  const visit = await grantPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    await visit.reveal();
    const select = visit.page.getByRole('combobox', {
      name: 'Access expires after',
    });
    await select.waitFor();
    expect(await select.innerText()).toBe('30 days');
    expect(
      await visit.page
        .getByText(/^Nook rejects this machine's token after .+\.$/)
        .count(),
    ).toBe(1);
    expect(
      await visit.page.getByText('Request expires', { exact: true }).count(),
    ).toBe(1);
    await select.click();
    expect(await visit.page.getByRole('option').allTextContents()).toEqual(
      lifetimes.map(([, label]) => label),
    );
    await visit.page
      .getByRole('option', { name: 'No expiration', exact: true })
      .click();
    expect(
      await visit.page
        .getByText('The token works until you revoke it.', { exact: true })
        .count(),
    ).toBe(1);
    await expectNoOverflow(visit.page);
  } finally {
    await visit.close();
  }
});
it.each(lifetimes)(
  'Expiry E2: approving %s through Chromium shows its date or Never and grants exactly that D1 lifetime',
  async (lifetime, label, duration) => {
    const visit = await grantPage(browser);
    try {
      await visit.reveal();
      await visit.page
        .getByRole('combobox', { name: 'Access expires after' })
        .click();
      await visit.page
        .getByRole('option', { name: label, exact: true })
        .click();
      const before = await d1Now(visit.app);
      await visit.page
        .getByRole('button', { name: 'Approve', exact: true })
        .click();
      await visit.page
        .getByRole('heading', { name: 'Machine approved' })
        .waitFor();
      const after = await d1Now(visit.app);
      expect(visit.approvals).toEqual([
        { machineName: 'omarchy', grant: ['me'], lifetime },
      ]);
      const poll = await jsonRequest(visit.app, '/api/machine/token', {
        deviceCode: visit.pending.deviceCode,
      });
      expect(poll.status).toBe(200);
      const token = ((await poll.json()) as { token: string }).token;
      const identity = (await (
        await machineIdentity(visit.app, token)
      ).json()) as { expiresAt: string | null };
      const shown = await expiresRow(visit.page);
      if (duration === null) {
        expect(identity.expiresAt).toBeNull();
        expect(shown).toBe('Never');
      } else {
        expect(Date.parse(identity.expiresAt!)).toBeGreaterThanOrEqual(
          before + duration,
        );
        expect(Date.parse(identity.expiresAt!)).toBeLessThanOrEqual(
          after + duration,
        );
        // The approved screen uses the displayed approval instant; D1 is the
        // stored authority. Compare readable times allowing a minute boundary.
        const possible = new Set([
          dateTime(new Date(before + duration).toISOString()),
          dateTime(new Date(after + duration).toISOString()),
        ]);
        expect(possible.has(shown)).toBe(true);
      }
    } finally {
      await visit.close();
    }
  },
);
it('Expiry E7/E12: Expired comes first with full facts and only Remove; live rows put expiry inside Approved', async () => {
  const visit = await expiryPage(browser);
  try {
    const { page } = visit;
    await machineRow(page, visit.machines[0].id).waitFor();
    expect(
      (await page.getByRole('heading', { level: 2 }).allTextContents())[0],
    ).toBe('Expired');
    const group = page.getByRole('region', { name: 'Expired', exact: true });
    expect(await group.innerText()).toContain(
      "Nook rejects these machines' tokens. Remove them, or run nook login on a machine to approve it again.",
    );
    const expired = machineRow(page, visit.machines[0].id);
    const listed = (await listMachines(visit.app)) as unknown as {
      id: string;
      expiresAt: string | null;
    }[];
    expect(await expired.innerText()).toContain(
      `Expired ${date(listed.find((m) => m.id === visit.machines[0].id)!.expiresAt!)}`,
    );
    for (const fact of ['Last used', 'Approved', 'Access:'])
      expect(await expired.innerText()).toContain(fact);
    expect(await expired.getByRole('button').allTextContents()).toEqual([
      'Remove',
    ]);
    for (const [index, text] of [
      [1, 'No expiration'],
      [2, 'Expires in 1 hour'],
      [
        3,
        `Expires ${date(listed.find((m) => m.id === visit.machines[3].id)!.expiresAt!)}`,
      ],
    ] as const) {
      const row = machineRow(page, visit.machines[index].id);
      const line = row.locator('[data-slot="item-description"]').last();
      expect(await line.innerText()).toContain(text);
      expect(await line.innerText()).toContain('Approved');
    }
  } finally {
    await visit.close();
  }
});
it('Expiry E13: Remove deletes immediately without confirmation and shows the reconnect command; live Revoke still confirms', async () => {
  const visit = await expiryPage(browser);
  try {
    const { page } = visit;
    await machineRow(page, visit.machines[0].id)
      .getByRole('button', { name: /Remove/ })
      .click();
    await page.getByText('Removed expired-sandbox', { exact: true }).waitFor();
    expect(await page.getByRole('alertdialog').count()).toBe(0);
    expect(await machineRow(page, visit.machines[0].id).count()).toBe(0);
    expect(await page.getByRole('alert').innerText()).toContain(
      'Its expired token is deleted. To reconnect that machine, run this on it and approve it again:',
    );
    expect(await page.getByRole('alert').innerText()).toContain(
      `nook login ${visit.app.origin}`,
    );
    expect(
      (await listMachines(visit.app)).some(
        (m) => m.id === visit.machines[0].id,
      ),
    ).toBe(false);
    await machineRow(page, visit.machines[1].id)
      .getByRole('button', { name: /Revoke/ })
      .click();
    await page.getByRole('alertdialog').waitFor();
  } finally {
    await visit.close();
  }
});
it('Expiry E14: an idle page moves a machine into Expired within a minute without a network reload', async () => {
  const visit = await expiryPage(browser, {
    configure: async (page, app) => {
      const now = await d1Now(app);
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "UPDATE machine_tokens SET access_expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+10000 WHERE machine_name='short-lived'",
        )
        .run();
      await page.clock.setFixedTime(new Date(now));
    },
  });
  try {
    const { page } = visit;
    const row = machineRow(page, visit.machines[2].id);
    await row.getByRole('button', { name: /Revoke/ }).waitFor();
    const requests = visit.requests.length;
    const now = await page.evaluate(() => Date.now());
    await page.clock.setFixedTime(new Date(now + 60_000));
    await page.clock.runFor(60_000);
    await row.getByRole('button', { name: /Remove/ }).waitFor();
    expect(
      await page
        .getByRole('region', { name: 'Expired', exact: true })
        .locator('[data-machine]')
        .count(),
    ).toBe(2);
    expect(visit.requests).toHaveLength(requests);
  } finally {
    await visit.close();
  }
});
it('Expiry E12/E14: an open access editor closes at expiry, discards its draft and restores focus', async () => {
  const visit = await expiryPage(browser, {
    configure: async (_page, app, now) => {
      await seedGrantTree(app, ['me']);
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "UPDATE machine_tokens SET access_expires_at=? WHERE machine_name='short-lived'",
        )
        .bind(now + 10_000)
        .run();
    },
  });
  try {
    const { page } = visit;
    const machine = visit.machines[2];
    const row = machineRow(page, machine.id);
    await row.getByRole('button', { name: /Edit access/ }).click();
    const sheet = page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    await sheet
      .getByRole('checkbox', { name: 'All buckets', exact: true })
      .uncheck();
    await sheet.getByRole('checkbox', { name: 'me', exact: true }).check();
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(true);
    const expiresAt = (await listMachines(visit.app)).find(
      (entry) => entry.id === machine.id,
    )?.expiresAt;
    if (!expiresAt) throw new Error('The edited machine must have an expiry.');
    await page.clock.setFixedTime(new Date(expiresAt));
    await page.clock.runFor(60_000);
    await sheet.waitFor({ state: 'hidden' });
    expect(
      await page
        .getByRole('button', { name: 'Save access', exact: true })
        .count(),
    ).toBe(0);
    expect(
      await page
        .getByRole('region', { name: 'Expired', exact: true })
        .locator(`[data-machine="${machine.id}"]`)
        .count(),
    ).toBe(1);
    expect(await row.getByRole('button').allTextContents()).toEqual(['Remove']);
    await expect
      .poll(() =>
        page
          .getByRole('heading', { name: 'Machines', exact: true })
          .evaluate((heading) => heading === document.activeElement),
      )
      .toBe(true);
    expect(
      visit.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);
    expect(
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toBe('all');
  } finally {
    await visit.close();
  }
});
it('Expiry E12/E14: Enter during the expiry close animation sends no PUT and preserves access', async () => {
  const visit = await expiryPage(browser, {
    configure: async (_page, app, now) => {
      await seedGrantTree(app, ['me']);
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "UPDATE machine_tokens SET access_expires_at=? WHERE machine_name='short-lived'",
        )
        .bind(now + 10_000)
        .run();
    },
  });
  try {
    const { page } = visit;
    const machine = (await listMachines(visit.app)).find(
      (entry) => entry.id === visit.machines[2].id,
    );
    if (!machine?.expiresAt)
      throw new Error('An expiring machine is required.');
    await machineRow(page, machine.id)
      .getByRole('button', { name: /Edit access/ })
      .click();
    const sheet = page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    await sheet
      .getByRole('checkbox', { name: 'All buckets', exact: true })
      .uncheck();
    await sheet.getByRole('checkbox', { name: 'me', exact: true }).check();
    const save = sheet.getByRole('button', {
      name: 'Save access',
      exact: true,
    });
    expect(await save.isEnabled()).toBe(true);
    await save.focus();
    // Hold the real exit animation so a loaded CI host cannot miss its window.
    const animation = await page.addStyleTag({
      content:
        '[data-slot="sheet-content"][data-state="closed"] { animation-play-state: paused; }',
    });
    await page.clock.setFixedTime(new Date(machine.expiresAt));
    await page.clock.runFor(60_000);
    expect(await sheet.getAttribute('data-state')).toBe('closed');
    expect(await sheet.isVisible()).toBe(true);
    expect(
      await save.evaluate((button) => button === document.activeElement),
    ).toBe(true);
    await page.keyboard.press('Enter');
    await animation.evaluate((style) => {
      style.parentNode?.removeChild(style);
    });
    await sheet.waitFor({ state: 'hidden' });
    expect(
      visit.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);
    expect(
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toBe('all');
    expect(
      await machineRow(page, machine.id).getByRole('button').allTextContents(),
    ).toEqual(['Remove']);
  } finally {
    await visit.close();
  }
});
it.each(['Escape', 'Close'])(
  'Expiry E12/E14: a save settled after expiry leaves the next editor dismissible with %s',
  async (dismissal) => {
    const gate = deferred();
    const entered = deferred();
    const visit = await expiryPage(browser, {
      configure: async (page, app, now) => {
        await seedGrantTree(app, ['me']);
        await (await app.mf.getD1Database('DB'))
          .prepare(
            "UPDATE machine_tokens SET access_expires_at=? WHERE machine_name='short-lived'",
          )
          .bind(now + 10_000)
          .run();
        await page.route('**/api/machines/*/grant', async (route) => {
          entered.resolve();
          await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    try {
      const { page } = visit;
      const machine = (await listMachines(visit.app)).find(
        (entry) => entry.id === visit.machines[2].id,
      );
      if (!machine?.expiresAt)
        throw new Error('An expiring machine is required.');
      await machineRow(page, machine.id)
        .getByRole('button', { name: /Edit access/ })
        .click();
      const sheet = page.getByRole('dialog', {
        name: 'Edit access',
        exact: true,
      });
      await sheet
        .getByRole('checkbox', { name: 'All buckets', exact: true })
        .uncheck();
      await sheet.getByRole('checkbox', { name: 'me', exact: true }).check();
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await entered.promise;
      await page.clock.setFixedTime(new Date(machine.expiresAt));
      await page.clock.runFor(60_000);
      await sheet.waitFor({ state: 'hidden' });
      expect(await sheet.count()).toBe(0);
      expect(
        await machineRow(page, machine.id)
          .getByRole('button')
          .allTextContents(),
      ).toEqual(['Remove']);
      expect(
        (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
          ?.grant,
      ).toBe('all');
      const response = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/api/machines/${machine.id}/grant`),
      );
      gate.resolve();
      expect((await response).status()).toBe(200);
      await expect
        .poll(
          async () =>
            (await listMachines(visit.app)).find(
              (entry) => entry.id === machine.id,
            )?.grant,
        )
        .toEqual(['me']);
      const trigger = machineRow(page, visit.machines[1].id).getByRole(
        'button',
        {
          name: /Edit access/,
        },
      );
      await trigger.click();
      await sheet.getByRole('checkbox', { name: 'me', exact: true }).waitFor();
      if (dismissal === 'Escape') await page.keyboard.press('Escape');
      else
        await sheet.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await sheet.getAttribute('data-state')).toBe('closed');
      await sheet.waitFor({ state: 'hidden' });
      await expect
        .poll(() =>
          trigger.evaluate((button) => button === document.activeElement),
        )
        .toBe(true);
      expect(
        visit.requests.filter((request) => request.method === 'PUT'),
      ).toHaveLength(1);
      expect(
        (await listMachines(visit.app)).find(
          (entry) => entry.id === visit.machines[1].id,
        )?.grant,
      ).toBe('all');
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);
it('Expiry E14: a 90-day timer is clamped and does not immediately rerender in a loop', async () => {
  const delays: number[] = [];
  const visit = await expiryPage(browser, {
    configure: async (page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "UPDATE machine_tokens SET access_expires_at=CAST(unixepoch('subsec')*1000 AS INTEGER)+? WHERE machine_name<>'never-expiring'",
        )
        .bind(90 * dayMs)
        .run();
      await page.exposeFunction('expiryTimer', (delay: number) =>
        delays.push(delay),
      );
      await page.addInitScript(() => {
        const original = window.setTimeout;
        window.setTimeout = ((
          handler: TimerHandler,
          delay?: number,
          ...args: unknown[]
        ) => {
          void (
            window as unknown as {
              expiryTimer: (delay: number) => Promise<void>;
            }
          ).expiryTimer(delay ?? 0);
          return original(handler, delay, ...args);
        }) as typeof window.setTimeout;
      });
    },
  });
  try {
    await machineRow(visit.page, visit.machines[0].id).waitFor();
    expect(delays.length).toBeGreaterThan(0);
    expect(delays.every((delay) => delay < 2 ** 31 - 1)).toBe(true);
    expect(
      await visit.page
        .getByRole('heading', { name: 'Expired', exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
