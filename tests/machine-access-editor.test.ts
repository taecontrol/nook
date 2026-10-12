import type { Browser, Locator } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { jsonRequest } from './support/authorizations.ts';
import {
  accessPage,
  editAccess,
  saveAccess,
} from './support/machine-access.ts';
import { deferred, listMachines, machinesNow } from './support/machines.ts';
import { machineRow } from './support/machines-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

async function bounds(locator: Locator) {
  const box = await locator.boundingBox();
  expect(box).not.toBeNull();
  if (!box) throw new Error('The visible editor element needs bounds');
  return box;
}

it('E17: keyboard focus intent preloads the checked editor without a pointer hover', async () => {
  const visit = await accessPage(browser);
  try {
    const button = machineRow(visit.page, visit.machines[0].id).getByRole(
      'button',
      { name: /Edit access/ },
    );
    await button.waitFor();
    await visit.page.waitForLoadState('networkidle');
    expect(
      visit.requests.filter((request) => request.path === '/api/buckets'),
    ).toEqual([]);
    expect(
      visit.requests.filter((request) =>
        /machine-access-sheet.*\.js$/.test(request.path),
      ),
    ).toEqual([]);
    const responses = Promise.all([
      visit.page.waitForResponse(
        (response) => new URL(response.url()).pathname === '/api/buckets',
      ),
      visit.page.waitForResponse((response) =>
        /machine-access-sheet.*\.js$/.test(new URL(response.url()).pathname),
      ),
    ]);
    await button.focus();
    expect((await responses).map((response) => response.status())).toEqual([
      200, 200,
    ]);
    const count = visit.requests.length;
    const sheet = await editAccess(visit.page, visit.machines[0]);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      visit.requests
        .slice(count)
        .filter((request) => request.path === '/api/buckets'),
    ).toEqual([]);
  } finally {
    await visit.close();
  }
});

it('E11/E16: phone machine actions stack vertically before opening the editor', async () => {
  const visit = await accessPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    const row = machineRow(visit.page, visit.machines[0].id);
    await row.scrollIntoViewIfNeeded();
    const edit = await bounds(row.getByRole('button', { name: /Edit access/ }));
    const revoke = await bounds(row.getByRole('button', { name: /Revoke/ }));
    expect(edit).not.toBeNull();
    expect(revoke).not.toBeNull();
    expect(revoke.x).toBe(edit.x);
    expect(revoke.y).toBeGreaterThanOrEqual(edit.y + edit.height);
    expect(
      await visit.page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await visit.close();
  }
});

it('E11/E17: wheeling the phone outline scrolls its sheet body between the fixed header and footer', async () => {
  const visit = await accessPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    const heading = sheet.getByRole('heading', {
      name: 'Bucket access',
      exact: true,
    });
    const header = sheet.getByRole('heading', {
      name: 'Edit access',
      exact: true,
    });
    const footer = sheet.locator('[data-slot="sheet-footer"]');
    const outline = await bounds(
      sheet.getByRole('group', { name: 'Bucket access', exact: true }),
    );
    const start = (await bounds(heading)).y;
    const fixedHeader = (await bounds(header)).y;
    const fixedFooter = (await bounds(footer)).y;
    expect(outline).not.toBeNull();
    await visit.page.mouse.move(outline.x + 30, outline.y + 50);
    await visit.page.mouse.wheel(0, 200);
    await expect
      .poll(async () => (await bounds(heading)).y)
      .toBeLessThan(start - 100);
    expect((await bounds(header)).y).toBe(fixedHeader);
    expect((await bounds(footer)).y).toBe(fixedFooter);
  } finally {
    await visit.close();
  }
});

it('E3/E13: narrowing an all grant preserves only explicit roots and explains the retained access', async () => {
  const visit = await accessPage(browser);
  try {
    const machine = visit.machines[1];
    const sheet = await editAccess(visit.page, machine);
    const all = sheet.getByRole('checkbox', {
      name: 'All buckets',
      exact: true,
    });
    const save = sheet.getByRole('button', {
      name: 'Save access',
      exact: true,
    });
    const footer = sheet.locator('[data-slot="sheet-footer"]');
    expect(await all.isChecked()).toBe(true);
    expect(await sheet.getByRole('alert').count()).toBe(0);
    expect(await save.isEnabled()).toBe(false);
    expect(await footer.innerText()).toContain('No changes yet.');
    await all.uncheck();
    expect(
      await sheet
        .getByRole('checkbox', { name: 'me', exact: true })
        .isChecked(),
    ).toBe(false);
    expect(await save.isEnabled()).toBe(false);
    await sheet
      .getByRole('checkbox', { name: 'work/acme', exact: true })
      .check();
    expect(await footer.innerText()).toMatch(
      /Removes\s+All buckets\s+Other buckets become read only or hidden/,
    );
    expect(await footer.innerText()).toMatch(
      /Keeps\s+work\/acme\s+Keeps read and write/,
    );
    expect(await sheet.innerText()).toContain('Now: All buckets');
    await save.click();
    await sheet.waitFor({ state: 'hidden' });
    expect(
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toEqual(['work/acme']);
  } finally {
    await visit.close();
  }
});

it('E11: narrowing an ancestor makes that ancestor read only in the footer', async () => {
  const visit = await accessPage(browser, {
    configure: async (_page, app) => {
      const machine = (await listMachines(app)).find(
        (entry) =>
          entry.name === 'framework-13' &&
          Array.isArray(entry.grant) &&
          entry.grant.includes('work/acme'),
      );
      expect(machine).toBeDefined();
      if (!machine) throw new Error('The approved fixture machine must exist');
      expect(
        (await saveAccess(app, machine.id, ['work'], ['work/acme'])).status,
      ).toBe(200);
    },
  });
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet.getByRole('checkbox', { name: 'work', exact: true }).uncheck();
    await sheet
      .getByRole('checkbox', { name: 'work/acme', exact: true })
      .check();
    expect(
      await sheet.locator('[data-slot="sheet-footer"]').innerText(),
    ).toMatch(/Removes\s+work\s+Becomes read only/);
  } finally {
    await visit.close();
  }
});

it('E11/E12: pending Save and Cancel are disabled and a failed save restores native dismissal', async () => {
  const gate = deferred();
  const entered = deferred();
  const visit = await accessPage(browser, {
    configure: async (page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare(
          "CREATE TRIGGER editor_failure BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
        )
        .run();
      await page.route('**/api/machines/*/grant', async (route) => {
        entered.resolve();
        await gate.promise;
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await entered.promise;
    expect(
      await sheet.getByRole('button', { name: /Saving/ }).isDisabled(),
    ).toBe(true);
    expect(
      await sheet
        .getByRole('button', { name: 'Cancel', exact: true })
        .isDisabled(),
    ).toBe(true);
    const focus = await sheet.evaluate((dialog) => {
      const active = document.activeElement;
      const inside = active instanceof HTMLElement && dialog.contains(active);
      const disabled =
        active instanceof HTMLElement &&
        active.matches(':disabled, [aria-disabled="true"]');
      const focusable =
        active instanceof HTMLElement &&
        (active.tabIndex >= 0 || active.hasAttribute('tabindex'));
      return { inside, usable: inside && focusable && !disabled };
    });
    expect(focus.inside).toBe(true);
    expect(focus.usable).toBe(true);
    gate.resolve();
    await sheet.getByRole('alert').waitFor();
    await expect
      .poll(() =>
        sheet
          .getByRole('alert')
          .evaluate((alert) => alert === document.activeElement),
      )
      .toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(true);
    await visit.page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    expect(
      (await listMachines(visit.app)).find(
        (entry) => entry.id === visit.machines[0].id,
      )?.grant,
    ).toEqual(['work/acme']);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it.each(['limited', 'all'] as const)(
  'E12: missing-root recovery keeps a changed remaining draft disabled until a new %s choice',
  async (choice) => {
    const visit = await accessPage(browser);
    try {
      const sheet = await editAccess(visit.page, visit.machines[0]);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .check();
      await sheet
        .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
        .check();
      expect(
        (
          await jsonRequest(
            visit.app,
            '/api/buckets/work%2Fbeta',
            undefined,
            {},
            'DELETE',
          )
        ).status,
      ).toBe(204);
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await expect
        .poll(() => sheet.getByRole('alert').innerText())
        .toContain('Some selected buckets no longer exist. Choose again.');
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .waitFor({ state: 'hidden' });
      expect(
        await sheet
          .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
          .isChecked(),
      ).toBe(true);
      await expect
        .poll(() => sheet.locator('form').getAttribute('aria-busy'))
        .toBe('false');
      expect(
        await sheet
          .getByRole('button', { name: 'Save access', exact: true })
          .isDisabled(),
      ).toBe(true);
      if (choice === 'all')
        await sheet
          .getByRole('checkbox', { name: 'All buckets', exact: true })
          .check();
      else
        await sheet
          .getByRole('checkbox', {
            name: 'clients/acme-logistics',
            exact: true,
          })
          .check();
      expect(
        await sheet
          .getByRole('button', { name: 'Save access', exact: true })
          .isEnabled(),
      ).toBe(true);
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await sheet.waitFor({ state: 'hidden' });
      expect(
        (await listMachines(visit.app)).find(
          (entry) => entry.id === visit.machines[0].id,
        )?.grant,
      ).toEqual(
        choice === 'all'
          ? 'all'
          : ['clients/acme-logistics', 'work/acme', 'work/taecontrol'],
      );
    } finally {
      await visit.close();
    }
  },
);

it('E12: a fresh limited choice remains disabled while the real missing-root tree refresh is held', async () => {
  let hold = false;
  const gate = deferred();
  const entered = deferred();
  const visit = await accessPage(browser, {
    configure: async (page) => {
      await page.route('**/api/buckets', async (route) => {
        if (hold) {
          entered.resolve();
          await gate.promise;
        }
        await route.continue().catch(() => {});
      });
    },
  });
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    expect(
      (
        await jsonRequest(
          visit.app,
          '/api/buckets/work%2Fbeta',
          undefined,
          {},
          'DELETE',
        )
      ).status,
    ).toBe(204);
    hold = true;
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await entered.promise;
    await expect
      .poll(() => sheet.getByRole('alert').innerText())
      .toContain('Some selected buckets no longer exist. Choose again.');
    await sheet
      .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
      .check();
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isDisabled(),
    ).toBe(true);
    gate.resolve();
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .waitFor({ state: 'hidden' });
    await expect
      .poll(() =>
        sheet
          .getByRole('button', { name: 'Save access', exact: true })
          .isEnabled(),
      )
      .toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E11: native focus and Enter reopening during the exit animation discards the previous draft', async () => {
  const visit = await accessPage(browser);
  try {
    const machine = visit.machines[0];
    const sheet = await editAccess(visit.page, machine);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await visit.page.keyboard.press('Escape');
    const exiting = visit.page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
      includeHidden: true,
    });
    expect(await exiting.count()).toBe(1);
    expect(await exiting.getAttribute('data-state')).toBe('closed');
    const trigger = machineRow(visit.page, machine.id).getByRole('button', {
      name: /Edit access/,
      includeHidden: true,
    });
    await trigger.focus();
    expect(await exiting.getAttribute('data-state')).toBe('closed');
    await visit.page.keyboard.press('Enter');
    await expect.poll(() => sheet.getAttribute('data-state')).toBe('open');
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(false);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toEqual(['work/acme']);
    expect(
      visit.requests.filter((request) => request.method === 'PUT'),
    ).toEqual([]);
  } finally {
    await visit.close();
  }
});

it('E12: a cached tree failure explains the editor recovery and can save an All choice', async () => {
  const visit = await accessPage(browser);
  const db = await visit.app.mf.getD1Database('DB');
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await db.prepare('ALTER TABLE buckets RENAME TO unavailable_buckets').run();
    await visit.page.clock.setFixedTime(
      new Date(Date.parse(machinesNow) + 40_000),
    );
    const refresh = visit.page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/buckets',
    );
    await visit.page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
    });
    expect((await refresh).status()).toBe(503);
    const alert = sheet.getByRole('alert');
    await expect
      .poll(() => alert.innerText())
      .toContain("Couldn't load buckets");
    expect(await alert.innerText()).toContain('close this editor');
    expect(await alert.innerText()).not.toContain('deny this request');
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isDisabled(),
    ).toBe(true);
    await db.prepare('ALTER TABLE unavailable_buckets RENAME TO buckets').run();
    await sheet
      .getByRole('checkbox', { name: 'All buckets', exact: true })
      .check();
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(true);
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await sheet.waitFor({ state: 'hidden' });
    expect(
      (await listMachines(visit.app)).find(
        (entry) => entry.id === visit.machines[0].id,
      )?.grant,
    ).toBe('all');
  } finally {
    await visit.close();
  }
});
