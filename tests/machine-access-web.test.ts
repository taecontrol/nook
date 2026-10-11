import { readFile } from 'node:fs/promises';
import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { createAuthorization, jsonRequest } from './support/authorizations.ts';
import {
  accessPage,
  editAccess,
  saveAccess,
} from './support/machine-access.ts';
import {
  deferred,
  listMachines,
  machinesNow,
  revokeMachine,
} from './support/machines.ts';
import { machineRow } from './support/machines-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
const sizes = [
  { width: 1280, height: 900 },
  { width: 390, height: 844 },
];

it.each(sizes)(
  'E11: at $width px Close and Escape discard unsaved edits and return focus to Edit access',
  async (viewport) => {
    const visit = await accessPage(browser, { viewport });
    const machine = visit.machines[0];
    const trigger = machineRow(visit.page, machine.id).getByRole('button', {
      name: /Edit access/,
    });
    try {
      for (const dismissal of ['Close', 'Escape']) {
        const sheet = await editAccess(visit.page, machine);
        expect(
          await sheet
            .getByRole('checkbox', { name: 'work/beta', exact: true })
            .isChecked(),
        ).toBe(false);
        await sheet
          .getByRole('checkbox', { name: 'work/beta', exact: true })
          .check();
        if (dismissal === 'Close')
          await sheet
            .getByRole('button', { name: 'Close', exact: true })
            .click();
        else await visit.page.keyboard.press('Escape');
        await sheet.waitFor({ state: 'hidden' });
        await expect
          .poll(() =>
            trigger.evaluate((button) => button === document.activeElement),
          )
          .toBe(true);
        expect(
          (await listMachines(visit.app)).find(
            (entry) => entry.id === machine.id,
          )?.grant,
        ).toEqual(['work/acme']);
        expect(
          visit.requests.filter((request) => request.method === 'PUT'),
        ).toHaveLength(0);
      }
    } finally {
      await visit.close();
    }
  },
);

it.each(sizes)(
  'E11: at $width px an added sibling appears optimistically, preserves row position, and returns focus on success',
  async (viewport) => {
    const gate = deferred();
    const entered = deferred();
    const visit = await accessPage(browser, {
      viewport,
      configure: async (page) => {
        await page.route('**/api/machines/*/grant', async (route) => {
          entered.resolve();
          await gate.promise;
          await route.continue().catch(() => {});
        });
      },
    });
    const { page, machines } = visit;
    const machine = machines[0];
    const row = machineRow(page, machine.id);
    try {
      await row.waitFor();
      await row.scrollIntoViewIfNeeded();
      const above = await page
        .getByRole('heading', {
          name: 'Never used',
          exact: true,
          includeHidden: true,
        })
        .boundingBox();
      const position = await row.boundingBox();
      const sheet = await editAccess(page, machine);
      expect(
        await sheet
          .getByRole('checkbox', { name: 'work/acme', exact: true })
          .isChecked(),
      ).toBe(true);
      expect(await sheet.innerText()).toContain('Now: work/acme');
      expect(
        await sheet
          .getByRole('button', { name: 'Save access', exact: true })
          .isEnabled(),
      ).toBe(false);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .check();
      const footer = sheet.locator('[data-slot="sheet-footer"]');
      expect(await footer.innerText()).toContain('What saving changes');
      expect(await footer.innerText()).toMatch(
        /Adds\s+work\/beta\s+Read and write/,
      );
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await entered.promise;
      await page.keyboard.press('Escape');
      expect(await sheet.getAttribute('data-state')).toBe('open');
      await sheet.getByRole('button', { name: 'Close', exact: true }).click();
      expect(await sheet.getAttribute('data-state')).toBe('open');
      await expect
        .poll(() => row.innerText())
        .toContain('work/acme, work/beta');
      expect(
        (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
          ?.grant,
      ).toEqual(['work/acme']);
      expect(await row.innerText()).not.toContain('Access saved');
      expect(
        (
          await page
            .getByRole('heading', {
              name: 'Never used',
              exact: true,
              includeHidden: true,
            })
            .boundingBox()
        )?.y,
      ).toBe(above?.y);
      gate.resolve();
      await sheet.waitFor({ state: 'hidden' });
      expect(await row.innerText()).toContain('Access saved');
      await expect
        .poll(() =>
          row
            .getByRole('button', { name: /Edit access/ })
            .evaluate((button) => button === document.activeElement),
        )
        .toBe(true);
      expect((await row.boundingBox())?.y).toBe(position?.y);
      expect(
        (
          await page
            .getByRole('heading', {
              name: 'Never used',
              exact: true,
              includeHidden: true,
            })
            .boundingBox()
        )?.y,
      ).toBe(above?.y);
      expect(
        await page.locator('.sr-only[aria-live="polite"]').innerText(),
      ).toContain('Saved access for framework-13');
      expect(
        (await listMachines(visit.app)).find(
          (entry) => entry.id === machines[2].id,
        )?.grant,
      ).toEqual(['personal/finances']);
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth),
      ).toBe(viewport.width);
    } finally {
      gate.resolve();
      await visit.close();
    }
  },
);

it('E11: a confirmed save closes and returns focus while its recovery list is still pending', async () => {
  const gate = deferred();
  const entered = deferred();
  const visit = await accessPage(browser);
  const machine = visit.machines[0];
  const row = machineRow(visit.page, machine.id);
  try {
    const sheet = await editAccess(visit.page, machine);
    await visit.page.route('**/api/machines', async (route) => {
      entered.resolve();
      await gate.promise;
      await route.continue().catch(() => {});
    });
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    const response = visit.page.waitForResponse((response) =>
      response.url().endsWith('/grant'),
    );
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    expect((await response).status()).toBe(200);
    await entered.promise;
    expect(
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toEqual(['work/acme', 'work/beta']);
    await sheet.waitFor({ state: 'hidden', timeout: 2_000 });
    expect(await row.innerText()).toContain('Access saved');
    await expect
      .poll(() =>
        row
          .getByRole('button', { name: /Edit access/ })
          .evaluate((button) => button === document.activeElement),
      )
      .toBe(true);
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E12: an unconfirmed lost response retains the selection, reconciles the row, and safely retries the same request', async () => {
  let attempts = 0;
  const payloads: unknown[] = [];
  const visit = await accessPage(browser, {
    configure: async (page) => {
      await page.route('**/api/machines/*/grant', async (route) => {
        payloads.push(route.request().postDataJSON());
        if (++attempts === 1) {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await route.abort('failed');
        } else await route.continue();
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
    await expect
      .poll(() => sheet.getByRole('alert').innerText())
      .toContain('Saving again is safe');
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(true);
    await expect
      .poll(() => machineRow(visit.page, visit.machines[0].id).innerText())
      .toContain('work/acme, work/beta');
    expect(
      await sheet
        .getByRole('button', { name: 'Try again', exact: true })
        .isEnabled(),
    ).toBe(true);
    await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
    expect(payloads).toEqual([
      { grant: ['work/acme', 'work/beta'], previous: ['work/acme'] },
      { grant: ['work/acme', 'work/beta'], previous: ['work/acme'] },
    ]);
  } finally {
    await visit.close();
  }
});

it('E12: genuine D1 failure rolls the optimistic row back and keeps the sheet draft for retry', async () => {
  const visit = await accessPage(browser);
  const db = await visit.app.mf.getD1Database('DB');
  try {
    await db
      .prepare(
        "CREATE TRIGGER access_failure BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
      )
      .run();
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await sheet
      .getByRole('button', { name: 'Try again', exact: true })
      .waitFor();
    expect(await sheet.getByRole('alert').innerText()).toContain(
      'Saving again is safe',
    );
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(true);
    await expect
      .poll(() => machineRow(visit.page, visit.machines[0].id).innerText())
      .not.toContain('work/acme, work/beta');
    await db.prepare('DROP TRIGGER access_failure').run();
    await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
    await sheet.waitFor({ state: 'hidden' });
  } finally {
    await visit.close();
  }
});

it('E12: changed-elsewhere adopts the server baseline while retaining the draft and sends that baseline on the next save', async () => {
  const visit = await accessPage(browser);
  const { page, app } = visit;
  const machine = visit.machines[0];
  const payloads: unknown[] = [];
  try {
    await page.route('**/api/machines/*/grant', async (route) => {
      payloads.push(route.request().postDataJSON());
      await route.continue();
    });
    const sheet = await editAccess(page, machine);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    expect(
      (
        await saveAccess(
          app,
          machine.id,
          ['work/acme', 'work/taecontrol'],
          ['work/acme'],
        )
      ).status,
    ).toBe(200);
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await expect
      .poll(() => sheet.getByRole('alert').innerText())
      .toContain('Access changed elsewhere');
    expect(await sheet.innerText()).toContain(
      'Now: work/acme, work/taecontrol',
    );
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
        .isChecked(),
    ).toBe(false);
    expect(
      await sheet.locator('[data-slot="sheet-footer"]').innerText(),
    ).toMatch(/Removes\s+work\/taecontrol\s+Becomes hidden/);
    expect(await machineRow(page, machine.id).innerText()).toContain(
      'work/acme, work/taecontrol',
    );
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await sheet.waitFor({ state: 'hidden' });
    expect(payloads[1]).toEqual({
      grant: ['work/acme', 'work/beta'],
      previous: ['work/acme', 'work/taecontrol'],
    });
  } finally {
    await visit.close();
  }
});

it.each(sizes)(
  'E12: at $width px a selected bucket deleted elsewhere refreshes the tree, shows the complete guidance, and disables Save until another choice',
  async (viewport) => {
    const visit = await accessPage(browser, { viewport });
    try {
      const sheet = await editAccess(visit.page, visit.machines[0]);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .check();
      await (await visit.app.mf.getD1Database('DB'))
        .prepare("DELETE FROM buckets WHERE path='work/beta'")
        .run();
      const refreshed = visit.page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/buckets',
      );
      await visit.page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      expect((await refreshed).status()).toBe(200);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .waitFor({ state: 'hidden' });
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      await expect
        .poll(() => sheet.getByRole('alert').innerText())
        .toContain('Some selected buckets no longer exist. Choose again.');
      expect(
        await sheet.locator('[data-slot="alert-title"]').evaluate((title) => {
          const content = document.createRange();
          content.selectNodeContents(title);
          const box = title.getBoundingClientRect();
          return [...content.getClientRects()].every(
            (line) => line.bottom <= box.bottom + 1,
          );
        }),
      ).toBe(true);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .waitFor({ state: 'hidden' });
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
        await machineRow(visit.page, visit.machines[0].id).innerText(),
      ).not.toContain('work/acme, work/beta');
      await sheet
        .getByRole('checkbox', { name: 'work/taecontrol', exact: true })
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
    } finally {
      await visit.close();
    }
  },
);

it('E12: a revoked machine disappears, leaves only an explanation and Close, and gives the actual reconnect command', async () => {
  const visit = await accessPage(browser);
  try {
    const machine = visit.machines[0];
    const sheet = await editAccess(visit.page, machine);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    expect((await revokeMachine(visit.app, machine.id)).status).toBe(204);
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    const close = sheet
      .locator('[data-slot="sheet-footer"]')
      .getByRole('button', { name: 'Close', exact: true });
    await close.waitFor();
    expect(await sheet.getByRole('alert').innerText()).toContain(
      'framework-13 was revoked',
    );
    expect(await sheet.getByRole('checkbox').count()).toBe(0);
    expect(
      await sheet.getByRole('button', { name: /Save access|Cancel/ }).count(),
    ).toBe(0);
    expect(await machineRow(visit.page, machine.id).count()).toBe(0);
    await close.click();
    await sheet.waitFor({ state: 'hidden' });
    expect(await visit.page.getByRole('alert').innerText()).toContain(
      `nook login ${visit.app.origin}`,
    );
    expect(await visit.page.getByRole('alert').innerText()).toContain(
      'was revoked elsewhere',
    );
  } finally {
    await visit.close();
  }
});

it.each(sizes)(
  'E13: at $width px unchanged and empty drafts disable Save and All buckets restores limited picks',
  async (viewport) => {
    const visit = await accessPage(browser, { viewport });
    try {
      const sheet = await editAccess(visit.page, visit.machines[0]);
      const save = sheet.getByRole('button', {
        name: 'Save access',
        exact: true,
      });
      expect(await save.isEnabled()).toBe(false);
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .uncheck();
      expect(await save.isEnabled()).toBe(false);
      expect(
        await sheet.locator('[data-slot="sheet-footer"]').innerText(),
      ).toContain(
        'Choose at least one bucket. To remove all access, revoke the machine.',
      );
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .check();
      expect(await save.isEnabled()).toBe(true);
      await sheet
        .getByRole('checkbox', { name: 'All buckets', exact: true })
        .check();
      expect(
        await sheet.locator('[data-slot="sheet-footer"]').innerText(),
      ).toContain('Every current and future bucket');
      await sheet
        .getByRole('checkbox', { name: 'All buckets', exact: true })
        .uncheck();
      expect(
        await sheet
          .getByRole('checkbox', { name: 'work/beta', exact: true })
          .isChecked(),
      ).toBe(true);
      await sheet.getByRole('button', { name: 'Cancel', exact: true }).click();
      await sheet.waitFor({ state: 'hidden' });
      await expect
        .poll(() =>
          machineRow(visit.page, visit.machines[0].id)
            .getByRole('button', { name: /Edit access/ })
            .evaluate((button) => button === document.activeElement),
        )
        .toBe(true);
    } finally {
      await visit.close();
    }
  },
);

it('E13/E14: deleting the last stored root during editing leaves no checked roots and keeps Save disabled', async () => {
  const visit = await accessPage(browser, {
    configure: async (_page, app) => {
      expect(
        (
          await jsonRequest(app, '/api/buckets', {
            path: 'work/old-experiment',
          })
        ).status,
      ).toBe(200);
      const target = (await listMachines(app)).find(
        (machine) =>
          machine.name === 'framework-13' &&
          machine.grant !== 'all' &&
          machine.grant[0] === 'work/acme',
      );
      if (!target) throw new Error('The synthetic machine must exist');
      expect(
        (
          await saveAccess(
            app,
            target.id,
            ['work/old-experiment'],
            target.grant,
          )
        ).status,
      ).toBe(200);
    },
  });
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    const old = sheet.getByRole('checkbox', {
      name: 'work/old-experiment',
      exact: true,
    });
    expect(await old.isChecked()).toBe(true);
    expect(
      (
        await jsonRequest(
          visit.app,
          '/api/buckets/work%2Fold-experiment',
          undefined,
          {},
          'DELETE',
        )
      ).status,
    ).toBe(204);
    const refreshed = visit.page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/buckets',
    );
    await visit.page.evaluate(() =>
      window.dispatchEvent(new Event('visibilitychange')),
    );
    expect((await refreshed).status()).toBe(200);
    await old.waitFor({ state: 'hidden' });
    expect(
      await sheet
        .getByRole('checkbox')
        .evaluateAll((nodes) =>
          nodes.some((node) => node.getAttribute('aria-checked') === 'true'),
        ),
    ).toBe(false);
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(false);
    expect(
      await sheet.locator('[data-slot="sheet-footer"]').innerText(),
    ).toContain(
      'Choose at least one bucket. To remove all access, revoke the machine.',
    );
    expect(
      visit.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);
  } finally {
    await visit.close();
  }
});

it('E14: saving an existing grant with a deleted root drops it without another edit and never offers it again', async () => {
  const visit = await accessPage(browser);
  try {
    const machine = visit.machines[5];
    const sheet = await editAccess(visit.page, machine);
    expect(await sheet.getByRole('alert').innerText()).toContain(
      'It gives no access now, and saving removes it.',
    );
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/old-experiment', exact: true })
        .count(),
    ).toBe(0);
    expect(
      await sheet.locator('[data-slot="sheet-footer"]').innerText(),
    ).toMatch(/Removes\s+work\/old-experiment\s+No longer exists/);
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
      (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
        ?.grant,
    ).toEqual(['work/acme']);
    const reopened = await editAccess(visit.page, machine);
    expect(
      await reopened
        .getByRole('checkbox', { name: 'work/old-experiment', exact: true })
        .count(),
    ).toBe(0);
    expect(await reopened.getByRole('alert').count()).toBe(0);
    expect(
      await reopened
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(false);
  } finally {
    await visit.close();
  }
});

it.each([
  { draft: 'unchanged', addSibling: false, expected: ['work/acme'] },
  {
    draft: 'expanded',
    addSibling: true,
    expected: ['work/acme', 'work/beta'],
  },
])(
  'E14: a stored root deleted during editing is omitted from the first save while retaining the $draft draft',
  async ({ addSibling, expected }) => {
    const visit = await accessPage(browser, {
      configure: async (_page, app) => {
        expect(
          (
            await jsonRequest(app, '/api/buckets', {
              path: 'work/old-experiment',
            })
          ).status,
        ).toBe(200);
      },
    });
    const machine = visit.machines[5];
    try {
      const sheet = await editAccess(visit.page, machine);
      const old = sheet.getByRole('checkbox', {
        name: 'work/old-experiment',
        exact: true,
      });
      expect(await old.isChecked()).toBe(true);
      if (addSibling)
        await sheet
          .getByRole('checkbox', { name: 'work/beta', exact: true })
          .check();
      expect(
        (
          await fetch(
            `${visit.app.origin}/api/buckets/${encodeURIComponent('work/old-experiment')}`,
            { method: 'DELETE' },
          )
        ).status,
      ).toBe(204);
      const refreshed = visit.page.waitForResponse(
        (response) =>
          response.request().method() === 'GET' &&
          new URL(response.url()).pathname === '/api/buckets',
      );
      await visit.page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      expect((await refreshed).status()).toBe(200);
      await old.waitFor({ state: 'hidden' });
      await expect
        .poll(() => sheet.getByRole('alert').innerText())
        .toContain('It gives no access now, and saving removes it.');
      expect(
        await sheet.locator('[data-slot="sheet-footer"]').innerText(),
      ).toMatch(/Removes\s+work\/old-experiment\s+No longer exists/);
      await expect
        .poll(() =>
          sheet
            .getByRole('button', { name: 'Save access', exact: true })
            .isEnabled(),
        )
        .toBe(true);
      const saved = visit.page.waitForResponse(
        (response) => response.request().method() === 'PUT',
      );
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      const response = await saved;
      expect(response.status()).toBe(200);
      expect(response.request().postDataJSON()).toEqual({
        grant: expected,
        previous: ['work/acme', 'work/old-experiment'],
      });
      await sheet.waitFor({ state: 'hidden' });
      expect(
        (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
          ?.grant,
      ).toEqual(expected);
    } finally {
      await visit.close();
    }
  },
);

it.each(sizes)(
  'E14/E17: at $width px many long approved roots keep the checked tree and fixed Save footer reachable',
  async (viewport) => {
    const roots = Array.from({ length: 24 }, (_, index) =>
      [
        `scope${String(index).padStart(2, '0')}${'a'.repeat(25)}`,
        ...Array.from(
          { length: 5 },
          (_, level) =>
            `level${level}${String.fromCharCode(98 + level).repeat(26)}`,
        ),
      ].join('/'),
    );
    const visit = await accessPage(browser, {
      viewport,
      configure: async (_page, app) => {
        for (const path of roots)
          expect(
            (await jsonRequest(app, '/api/buckets', { path })).status,
          ).toBe(200);
        const target = (await listMachines(app)).find(
          (machine) =>
            machine.name === 'framework-13' &&
            machine.grant !== 'all' &&
            machine.grant.length === 1 &&
            machine.grant[0] === 'work/acme',
        );
        if (!target) throw new Error('The approved machine must be present.');
        expect(
          (await saveAccess(app, target.id, roots, target.grant)).status,
        ).toBe(200);
      },
    });
    try {
      const machine = visit.machines[0];
      const sheet = await editAccess(visit.page, machine);
      const checked = sheet.getByRole('checkbox', {
        name: roots[0],
        exact: true,
      });
      const now = sheet
        .locator('[data-slot="sheet-header"] p')
        .filter({ hasText: 'Now:' });
      await now.hover();
      await visit.page.mouse.wheel(0, 10_000);
      await expect
        .poll(() => now.evaluate((summary) => summary.scrollTop))
        .toBeGreaterThan(0);
      await expect
        .poll(() =>
          now.evaluate(
            (summary, lastRoot) => {
              const text = summary.querySelector('code')?.firstChild;
              if (!text?.textContent || text.nodeType !== Node.TEXT_NODE)
                return false;
              const offset = text.textContent.lastIndexOf(lastRoot);
              if (offset < 0) return false;
              const range = document.createRange();
              range.setStart(text, offset);
              range.setEnd(text, offset + lastRoot.length);
              const box = summary.getBoundingClientRect();
              const lines = [...range.getClientRects()];
              return (
                lines.length > 0 &&
                lines.every(
                  (line) =>
                    line.top >= box.top - 1 &&
                    line.bottom <= box.bottom + 1 &&
                    line.left >= box.left - 1 &&
                    line.right <= box.right + 1,
                )
              );
            },
            roots[roots.length - 1],
          ),
        )
        .toBe(true);
      const save = sheet.getByRole('button', {
        name: 'Save access',
        exact: true,
      });
      expect(await checked.isChecked()).toBe(true);
      const before = await save.boundingBox();
      if (!before) throw new Error('Save access must have visible bounds.');
      expect(before.y).toBeGreaterThanOrEqual(0);
      expect(before.y + before.height).toBeLessThanOrEqual(viewport.height);
      await checked.scrollIntoViewIfNeeded();
      const box = await checked.boundingBox();
      if (!box) throw new Error('The checked root must have visible bounds.');
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(before.y);
      expect((await save.boundingBox())?.y).toBe(before.y);
      await checked.uncheck();
      expect(await save.isEnabled()).toBe(true);
      const after = await save.boundingBox();
      if (!after) throw new Error('Save access must remain visible.');
      expect(after.y + after.height).toBeLessThanOrEqual(viewport.height);
      const saved = visit.page.waitForResponse(
        (response) => response.request().method() === 'PUT',
      );
      await save.click();
      expect((await saved).status()).toBe(200);
      await sheet.waitFor({ state: 'hidden' });
      expect(
        (await listMachines(visit.app)).find((entry) => entry.id === machine.id)
          ?.grant,
      ).toEqual(roots.slice(1));
    } finally {
      await visit.close();
    }
  },
);

it('E15: approval, approved result, and deployment guidance direct later access edits to Machines', async () => {
  const visit = await accessPage(browser);
  try {
    const pending = await createAuthorization(visit.app);
    await visit.page.goto(`${visit.app.origin}/cli/authorize`);
    await visit.page
      .getByRole('textbox', { name: 'Code from your terminal' })
      .fill(pending.userCode);
    await visit.page
      .getByRole('button', { name: 'Continue', exact: true })
      .click();
    await visit.page.getByRole('textbox', { name: 'Machine name' }).waitFor();
    expect(await visit.page.locator('main').innerText()).toContain(
      'To change access later, edit it in Machines.',
    );
    await visit.page
      .getByRole('button', { name: 'Approve', exact: true })
      .click();
    await visit.page
      .getByRole('heading', { name: 'Machine approved', exact: true })
      .waitFor();
    expect(await visit.page.locator('main').innerText()).toContain(
      'To change access later, edit it in Machines.',
    );
    const guidance = await readFile('docs/deployment.md', 'utf8');
    expect(guidance).toContain(
      'To change access, use Edit access in Machines.',
    );
    expect(guidance).not.toContain(
      'To change access, run logout, then log in again.',
    );
  } finally {
    await visit.close();
  }
});

it('E17: the editor chunk and buckets preload on intent and do not join the Machines cold-open path', async () => {
  const visit = await accessPage(browser);
  const { page, requests } = visit;
  try {
    const button = machineRow(page, visit.machines[0].id).getByRole('button', {
      name: /Edit access/,
    });
    await button.waitFor();
    await page.waitForLoadState('networkidle');
    expect(
      requests.filter((request) => request.path === '/api/buckets'),
    ).toEqual([]);
    expect(
      requests.filter((request) =>
        /machine-access-sheet.*\.js$/.test(request.path),
      ),
    ).toEqual([]);
    const buckets = page.waitForResponse(
      (response) => new URL(response.url()).pathname === '/api/buckets',
    );
    const chunk = page.waitForResponse((response) =>
      /machine-access-sheet.*\.js$/.test(new URL(response.url()).pathname),
    );
    await button.hover();
    expect((await buckets).status()).toBe(200);
    expect((await chunk).status()).toBe(200);
    const count = requests.length;
    await button.click();
    const sheet = page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    await sheet
      .getByRole('checkbox', { name: 'work/acme', exact: true })
      .waitFor();
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      requests
        .slice(count)
        .filter((request) => request.path === '/api/buckets'),
    ).toEqual([]);
  } finally {
    await visit.close();
  }
});

it('E17: an editor chunk transport failure uses the route error boundary and recovers after reload', async () => {
  let failing = true;
  const visit = await accessPage(browser, {
    configure: async (page) => {
      await page.route('**/machine-access-sheet-*.js', (route) =>
        failing ? route.abort('failed') : route.continue(),
      );
    },
  });
  try {
    await machineRow(visit.page, visit.machines[0].id)
      .getByRole('button', { name: /Edit access/ })
      .click();
    await visit.page
      .getByText('Something went wrong!', { exact: true })
      .waitFor();
    expect(
      visit.requests.filter((request) => request.method === 'PUT'),
    ).toHaveLength(0);
    failing = false;
    await visit.page.reload();
    const sheet = await editAccess(visit.page, visit.machines[0]);
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
    expect(
      (await listMachines(visit.app)).find(
        (entry) => entry.id === visit.machines[0].id,
      )?.grant,
    ).toEqual(['work/acme']);
  } finally {
    await visit.close();
  }
});

it('E12/E17: stale intent and focus reads cannot overwrite an optimistic grant during a pending save', async () => {
  const gate = deferred();
  const entered = deferred();
  const visit = await accessPage(browser, {
    configure: async (page) => {
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
    const reads = () =>
      visit.requests.filter(
        (request) =>
          request.path === '/api/machines' && request.method === 'GET',
      ).length;
    const before = reads();
    await visit.page.clock.setFixedTime(
      new Date(Date.parse(machinesNow) + 40_000),
    );
    await visit.page.evaluate(() => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('visibilitychange'));
    });
    await visit.page.clock.runFor(500);
    expect(reads()).toBe(before);
    expect(
      await machineRow(visit.page, visit.machines[0].id).innerText(),
    ).toContain('work/acme, work/beta');
    gate.resolve();
    await sheet.waitFor({ state: 'hidden' });
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E12: an unavailable bucket list presents its retry inside the sheet and recovers the checked tree', async () => {
  const visit = await accessPage(browser);
  const db = await visit.app.mf.getD1Database('DB');
  try {
    await db.prepare('ALTER TABLE buckets RENAME TO unavailable_buckets').run();
    await machineRow(visit.page, visit.machines[0].id)
      .getByRole('button', { name: /Edit access/ })
      .click();
    const sheet = visit.page.getByRole('dialog', {
      name: 'Edit access',
      exact: true,
    });
    await sheet.getByText("Couldn't load buckets", { exact: true }).waitFor();
    expect(
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .isEnabled(),
    ).toBe(false);
    await db.prepare('ALTER TABLE unavailable_buckets RENAME TO buckets').run();
    await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
    await sheet
      .getByRole('checkbox', { name: 'work/acme', exact: true })
      .waitFor();
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/acme', exact: true })
        .isChecked(),
    ).toBe(true);
  } finally {
    await visit.close();
  }
});
