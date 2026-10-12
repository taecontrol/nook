import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { ownerRuntime } from './support/authorizations.ts';
import { issueGrant } from './support/grants.ts';
import {
  accessPage,
  editAccess,
  saveAccess,
} from './support/machine-access.ts';
import {
  deferred,
  listMachines,
  machineIdentity,
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

it('E11/E12: a pending access save disables every machine action', async () => {
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
    await expect
      .poll(() => machineRow(visit.page, visit.machines[0].id).innerText())
      .toContain('work/acme, work/beta');
    for (const machine of [visit.machines[0], visit.machines[1]]) {
      const row = machineRow(visit.page, machine.id);
      expect(
        await row
          .getByRole('button', { name: /Edit access/, includeHidden: true })
          .isDisabled(),
      ).toBe(true);
      expect(
        await row
          .getByRole('button', { name: /Revoke/, includeHidden: true })
          .isDisabled(),
      ).toBe(true);
    }
    expect(
      await machineRow(visit.page, visit.machines[2].id).innerText(),
    ).toContain('Access: personal/finances');
  } finally {
    gate.resolve();
    await visit.close();
  }
});

it('E11/E12: an access save cancels an old machines read already in flight', async () => {
  const oldRead = deferred();
  const captured = deferred();
  const readFinished = deferred();
  const write = deferred();
  const entered = deferred();
  const visit = await accessPage(browser);
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await visit.page.route('**/api/machines', async (route) => {
      const response = await route.fetch();
      captured.resolve();
      await oldRead.promise;
      await route.fulfill({ response }).catch(() => {});
      readFinished.resolve();
    });
    await visit.page.route('**/api/machines/*/grant', async (route) => {
      entered.resolve();
      await write.promise;
      await route.continue().catch(() => {});
    });
    await visit.page.evaluate(() => {
      window.dispatchEvent(new Event('visibilitychange'));
      window.dispatchEvent(new Event('focus'));
    });
    await captured.promise;
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await entered.promise;
    const row = machineRow(visit.page, visit.machines[0].id);
    await expect.poll(() => row.innerText()).toContain('work/acme, work/beta');
    oldRead.resolve();
    await readFinished.promise;
    await visit.page.evaluate(
      () =>
        new Promise<void>((resolve) =>
          requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
        ),
    );
    expect(await row.innerText()).toContain('work/acme, work/beta');
  } finally {
    oldRead.resolve();
    write.resolve();
    await visit.page.unrouteAll({ behavior: 'wait' });
    await visit.close();
  }
});

it('E11: a successful save applies real machine activity facts before the recovery list', async () => {
  let privateToken = '';
  const visit = await accessPage(browser, {
    configure: async (_page, app) => {
      privateToken = (await issueGrant(app, ['work/acme'])).token;
    },
  });
  const write = deferred();
  const entered = deferred();
  const read = deferred();
  const recovery = deferred();
  try {
    const machine = (await listMachines(visit.app)).find(
      (entry) => entry.name === 'work-laptop',
    );
    if (!machine) throw new Error('The synthetic machine was not approved');
    expect(machine.lastUsedAt).toBe(null);
    const row = machineRow(visit.page, machine.id);
    expect(await row.innerText()).toContain('Never used');
    const sheet = await editAccess(visit.page, machine);
    await visit.page.route('**/api/machines/*/grant', async (route) => {
      entered.resolve();
      await write.promise;
      await route.continue().catch(() => {});
    });
    await visit.page.route('**/api/machines', async (route) => {
      recovery.resolve();
      await read.promise;
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
    await entered.promise;
    const activity = await machineIdentity(visit.app, privateToken);
    expect(activity.status).toBe(200);
    await activity.body?.cancel();
    write.resolve();
    expect((await response).status()).toBe(200);
    await recovery.promise;
    await expect.poll(() => row.innerText()).toContain('Last used');
    expect(await row.innerText()).not.toContain('Never used');
  } finally {
    write.resolve();
    read.resolve();
    await visit.close();
  }
});

it.each([404, 409])(
  'E12: a genuine %s reconciles the row and presents its alert before the recovery list',
  async (status) => {
    const visit = await accessPage(browser);
    const read = deferred();
    const recovery = deferred();
    try {
      const machine = visit.machines[0];
      const sheet = await editAccess(visit.page, machine);
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .check();
      const elsewhere =
        status === 404
          ? await revokeMachine(visit.app, machine.id)
          : await saveAccess(
              visit.app,
              machine.id,
              ['work/acme', 'work/taecontrol'],
              ['work/acme'],
            );
      expect(elsewhere.status).toBe(status === 404 ? 204 : 200);
      await visit.page.route('**/api/machines', async (route) => {
        recovery.resolve();
        await read.promise;
        await route.continue().catch(() => {});
      });
      const response = visit.page.waitForResponse((response) =>
        response.url().endsWith('/grant'),
      );
      await sheet
        .getByRole('button', { name: 'Save access', exact: true })
        .click();
      expect((await response).status()).toBe(status);
      await recovery.promise;
      const row = machineRow(visit.page, machine.id);
      if (status === 404) await expect.poll(() => row.count()).toBe(0);
      else
        await expect
          .poll(() => row.innerText())
          .toContain('work/acme, work/taecontrol');
      expect(
        await machineRow(visit.page, visit.machines[2].id).innerText(),
      ).toContain('Access: personal/finances');
      const alert = sheet.getByRole('alert');
      await expect
        .poll(() => alert.innerText())
        .toContain(status === 404 ? 'was revoked' : 'Access changed elsewhere');
      await expect
        .poll(() =>
          alert.evaluate((element) => element === document.activeElement),
        )
        .toBe(true);
      if (status === 409)
        expect(
          await sheet
            .getByRole('checkbox', { name: 'work/beta', exact: true })
            .isChecked(),
        ).toBe(true);
      else
        expect(
          await sheet
            .getByRole('button', { name: 'Close', exact: true })
            .count(),
        ).toBe(2);
    } finally {
      read.resolve();
      await visit.close();
    }
  },
);

it('E12: a failed retry keeps the last confirmed cache after an unconfirmed commit', async () => {
  let attempts = 0;
  const visit = await accessPage(browser, {
    configure: async (page) => {
      await page.route('**/api/machines/*/grant', async (route) => {
        if (++attempts === 1) {
          const response = await route.fetch();
          expect(response.status()).toBe(200);
          await route.abort('failed');
        } else await route.continue();
      });
    },
  });
  const read = deferred();
  const recovery = deferred();
  try {
    const machine = visit.machines[0];
    const sheet = await editAccess(visit.page, machine);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    await sheet
      .getByRole('button', { name: 'Try again', exact: true })
      .waitFor();
    const row = machineRow(visit.page, machine.id);
    await expect.poll(() => row.innerText()).toContain('work/acme, work/beta');
    await (await visit.app.mf.getD1Database('DB'))
      .prepare(
        "CREATE TRIGGER retry_failure BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
      )
      .run();
    await visit.page.route('**/api/machines', async (route) => {
      recovery.resolve();
      await read.promise;
      await route.continue().catch(() => {});
    });
    const response = visit.page.waitForResponse((response) =>
      response.url().endsWith('/grant'),
    );
    await sheet.getByRole('button', { name: 'Try again', exact: true }).click();
    expect((await response).status()).toBe(503);
    await recovery.promise;
    expect(await row.innerText()).toContain('work/acme, work/beta');
  } finally {
    read.resolve();
    await visit.close();
  }
});

it('E12: a definitive owner session failure asks for sign-in and retains the draft', async () => {
  const visit = await accessPage(browser);
  try {
    const sheet = await editAccess(visit.page, visit.machines[0]);
    await sheet
      .getByRole('checkbox', { name: 'work/beta', exact: true })
      .check();
    await visit.app.setBindings({
      LOCAL_OWNER: '',
      LOCAL_ORIGIN: visit.app.origin,
    });
    const response = visit.page.waitForResponse((response) =>
      response.url().endsWith('/grant'),
    );
    await sheet
      .getByRole('button', { name: 'Save access', exact: true })
      .click();
    expect((await response).status()).toBe(401);
    await expect
      .poll(() => sheet.getByRole('alert').innerText())
      .toContain('Sign in again');
    expect(
      await sheet
        .getByRole('checkbox', { name: 'work/beta', exact: true })
        .isChecked(),
    ).toBe(true);
    await ownerRuntime(visit.app);
    expect(
      (await listMachines(visit.app)).find(
        (entry) => entry.id === visit.machines[0].id,
      )?.grant,
    ).toEqual(['work/acme']);
  } finally {
    await visit.close();
  }
});
