import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { issueGrant } from './support/grants.ts';
import { accessPage, editAccess } from './support/machine-access.ts';
import { deferred, listMachines, machineIdentity } from './support/machines.ts';
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
