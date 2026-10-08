import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import {
  deferred,
  listMachines,
  longMachineName,
  machinesNow,
  manyMachines,
  typicalMachines,
} from './support/machines.ts';
import {
  confirmRevoke,
  machineRow,
  machinesPage,
} from './support/machines-browser.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});

it('E3: a never-used approval is rendered as Never used', async () => {
  const visit = await machinesPage(browser, { seeds: [typicalMachines[4]] });
  try {
    await machineRow(visit.page, visit.machines[0].id).waitFor();
    expect(
      await machineRow(visit.page, visit.machines[0].id).innerText(),
    ).toContain('Never used');
    expect((await listMachines(visit.app))[0].lastUsedAt).toBeNull();
  } finally {
    await visit.close();
  }
});
it('E17: Home and the Platform sidebar lead to Machines below Buckets with the Nook breadcrumb', async () => {
  const visit = await machinesPage(browser, { start: '/' });
  const { page } = visit;
  try {
    const platform = page.getByRole('region', {
      name: 'Platform',
      exact: true,
    });
    await platform.getByRole('link', { name: /Machines/ }).waitFor();
    expect(
      await platform
        .getByRole('link', { name: /Machines/ })
        .getAttribute('href'),
    ).toBe('/machines');
    const sidebar = page
      .locator('[data-slot="sidebar-group"]')
      .filter({ has: page.getByText('Platform', { exact: true }) });
    expect(await sidebar.getByRole('link').allTextContents()).toEqual([
      'Buckets',
      'Machines',
      'Audit',
    ]);
    const link = sidebar.getByRole('link', { name: 'Machines', exact: true });
    expect(await link.getAttribute('href')).toBe('/machines');
    await link.click();
    await machineRow(page, visit.machines[0].id).waitFor();
    expect(new URL(page.url()).pathname).toBe('/machines');
    const breadcrumb = page.getByRole('navigation', { name: 'breadcrumb' });
    expect(
      await breadcrumb
        .getByRole('link', { name: 'Nook', exact: true })
        .getAttribute('href'),
    ).toBe('/');
    expect(await breadcrumb.locator('[aria-current="page"]').innerText()).toBe(
      'Machines',
    );
    expect(await link.getAttribute('data-active')).toBe('true');
  } finally {
    await visit.close();
  }
});
it('E18: typical approvals are grouped stale, never, then recent, with counts and hints', async () => {
  const visit = await machinesPage(browser);
  const { page } = visit;
  try {
    await machineRow(page, visit.machines[0].id).waitFor();
    expect(
      await page.getByRole('heading', { level: 2 }).allTextContents(),
    ).toEqual([
      'Not used in 30 days',
      'Never used',
      'Used in the last 30 days',
    ]);
    for (const [title, names, count, hint] of [
      [
        'Not used in 30 days',
        ['framework-13'],
        '1',
        'No request from these machines for over 30 days. Revoke any you no longer use.',
      ],
      [
        'Never used',
        ['hetzner-vps'],
        '1',
        'Approved, but Nook has not received a request from them yet.',
      ],
      [
        'Used in the last 30 days',
        ['framework-13', 'omarchy-desktop', 'build-server'],
        '3',
        'Made a request to Nook recently.',
      ],
    ] as const) {
      const group = page.getByRole('region', { name: title, exact: true });
      expect(
        await group.locator('[data-slot="item-title"]').allTextContents(),
      ).toEqual(names);
      expect(await group.locator('[data-slot="badge"]').innerText()).toBe(
        count,
      );
      expect(await group.innerText()).toContain(hint);
    }
    expect(
      await page
        .getByRole('region', { name: 'Not used in 30 days' })
        .locator('[data-machine]')
        .getAttribute('data-machine'),
    ).toBe(visit.machines[2].id);
  } finally {
    await visit.close();
  }
});
it('E18: longest-idle, oldest-never, and newest-recent sort independently and empty groups are hidden', async () => {
  const visit = await machinesPage(browser, {
    seeds: [...manyMachines].reverse(),
  });
  const { page } = visit;
  try {
    await page.getByRole('region', { name: 'Not used in 30 days' }).waitFor();
    const names = async (title: string) =>
      page
        .getByRole('region', { name: title, exact: true })
        .locator('[data-slot="item-title"]')
        .allTextContents();
    expect(await names('Not used in 30 days')).toEqual([
      'thinkpad-x1',
      longMachineName,
      'framework-13',
      'dev-container',
    ]);
    expect(await names('Never used')).toEqual([
      'arch-mini-pc',
      'nas-backup',
      'hetzner-vps',
    ]);
    expect(await names('Used in the last 30 days')).toEqual([
      'framework-13',
      'ci-runner-01',
      'omarchy-desktop',
      'build-server',
      'raspberry-pi-garage',
    ]);
  } finally {
    await visit.close();
  }
  const single = await machinesPage(browser, { seeds: [typicalMachines[4]] });
  try {
    await machineRow(single.page, single.machines[0].id).waitFor();
    expect(
      await single.page.getByRole('heading', { level: 2 }).allTextContents(),
    ).toEqual(['Never used']);
  } finally {
    await single.close();
  }
});
it('E18: exactly thirty days remains recent and an open page regroups as the clock advances', async () => {
  const visit = await machinesPage(browser, {
    seeds: [
      {
        name: 'boundary',
        approvedAt: '2026-08-01T00:00:00.000Z',
        lastUsedAt: '2026-09-05T15:00:00.000Z',
      },
    ],
  });
  try {
    const { page } = visit;
    await machineRow(page, visit.machines[0].id).waitFor();
    expect(
      await page.getByRole('heading', { level: 2 }).allTextContents(),
    ).toEqual(['Used in the last 30 days']);
    await page.clock.setFixedTime(new Date(Date.parse(machinesNow) + 60_000));
    await page.clock.runFor(60_000);
    await expect
      .poll(() => page.getByRole('heading', { level: 2 }).allTextContents())
      .toEqual(['Not used in 30 days']);
  } finally {
    await visit.close();
  }
});
it('E19: mobile rows expose all facts and wrap a full 64-character name without clipping or overflow', async () => {
  expect(longMachineName.length).toBe(64);
  const visit = await machinesPage(browser, {
    seeds: manyMachines,
    viewport: { width: 390, height: 844 },
  });
  const { page } = visit;
  try {
    const stale = machineRow(page, visit.machines[2].id);
    await stale.waitFor();
    expect(await stale.innerText()).toContain(
      'Last used 52 days ago · Aug 14, 2026',
    );
    expect(await stale.innerText()).toContain(
      'Approved Jul 28, 2026 · Access: All buckets',
    );
    for (const machine of visit.machines)
      expect(
        await machineRow(page, machine.id)
          .getByRole('button', { name: /Revoke/ })
          .count(),
      ).toBe(1);
    const fullName = machineRow(
      page,
      visit.machines.find((machine) => machine.name === longMachineName)!.id,
    ).locator('[data-slot="item-title"]');
    expect(await fullName.innerText()).toBe(longMachineName);
    const bounds = await fullName.evaluate((element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return {
        wraps: box.height > Number.parseFloat(style.lineHeight),
        unclipped: element.scrollHeight <= element.clientHeight,
        right: box.right,
        left: box.left,
      };
    });
    expect(bounds.wraps).toBe(true);
    expect(bounds.unclipped).toBe(true);
    expect(bounds.left).toBeGreaterThanOrEqual(0);
    expect(bounds.right).toBeLessThanOrEqual(390);
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth),
    ).toBe(390);
  } finally {
    await visit.close();
  }
});
it('E20: confirmation identifies the duplicate approval, explains irreversible deletion, and Cancel changes nothing', async () => {
  const visit = await machinesPage(browser);
  const { page, machines, requests } = visit;
  try {
    const target = machineRow(page, machines[2].id);
    const trigger = target.getByRole('button', { name: /Revoke/ });
    await trigger.click();
    const dialog = page.getByRole('alertdialog');
    expect(await dialog.getByRole('heading').innerText()).toBe(
      'Revoke framework-13?',
    );
    expect(await dialog.innerText()).toContain('Approved Jul 28, 2026');
    expect(await dialog.innerText()).toContain(
      'Last used 52 days ago · Aug 14, 2026',
    );
    expect(await dialog.innerText()).toContain(
      "Its token is deleted immediately and this can't be undone.",
    );
    expect(await dialog.innerText()).toContain(
      "The machine's next request to Nook will fail.",
    );
    expect(await dialog.locator('code').innerText()).toBe(
      `nook login ${visit.app.origin}`,
    );
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect.poll(() => dialog.count()).toBe(0);
    expect(
      requests.filter((request) => request.method === 'DELETE'),
    ).toHaveLength(0);
    expect(await listMachines(visit.app)).toHaveLength(5);
    expect(await target.isVisible()).toBe(true);
    await expect
      .poll(() =>
        trigger.evaluate((button) => button === document.activeElement),
      )
      .toBe(true);
  } finally {
    await visit.close();
  }
});
it('E20/E22: reopening confirmation while the previous content is exiting keeps its action clickable', async () => {
  const visit = await machinesPage(browser);
  const { page, machines } = visit;
  try {
    // Hold the native content exit animation past the overlay exit, making
    // the otherwise brief portal-reordering window deterministic.
    await page.addStyleTag({
      content:
        '[data-slot="alert-dialog-content"][data-state="closed"] { animation-duration: 10s; }',
    });
    await machineRow(page, machines[2].id)
      .getByRole('button', { name: /Revoke/ })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Cancel', exact: true })
      .click();
    await expect
      .poll(() => page.locator('[data-slot="alert-dialog-overlay"]').count())
      .toBe(0);
    await machineRow(page, machines[4].id)
      .getByRole('button', { name: /Revoke/ })
      .click();
    expect(
      await page.getByRole('alertdialog').getByRole('heading').innerText(),
    ).toBe('Revoke hetzner-vps?');
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Revoke machine', exact: true })
      .click();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain('Revoked hetzner-vps');
    expect(await machineRow(page, machines[4].id).count()).toBe(0);
    expect(await listMachines(visit.app)).toHaveLength(4);
  } finally {
    await visit.close();
  }
});
it('E21: confirmed revoke removes a row while pending, claims success only after 204, and survives refetch', async () => {
  const gate = deferred();
  const refresh = deferred();
  const visit = await machinesPage(browser, {
    configure: async (page) => {
      let reads = 0;
      await page.route('**/api/machines', async (route) => {
        if (++reads > 1) await refresh.promise;
        await route.continue();
      });
      await page.route('**/api/machines/*', async (route) => {
        await gate.promise;
        await route.continue();
      });
    },
  });
  const { page, machines, requests } = visit;
  try {
    const target = machineRow(page, machines[2].id);
    await confirmRevoke(page, machines[2].id);
    await expect.poll(() => target.count()).toBe(0);
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain('Revoking framework-13…');
    expect(await page.getByRole('alert').innerText()).not.toContain('Revoked');
    expect(await listMachines(visit.app)).toHaveLength(5);
    gate.resolve();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain('Revoked framework-13');
    expect(await page.getByRole('alert').locator('code').innerText()).toBe(
      `nook login ${visit.app.origin}`,
    );
    await expect
      .poll(
        () =>
          requests.filter(
            (request) =>
              request.method === 'GET' && request.path === '/api/machines',
          ).length,
      )
      .toBe(2);
    expect(await target.count()).toBe(0);
    expect(await listMachines(visit.app)).toHaveLength(4);
    const reconciled = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/machines',
    );
    refresh.resolve();
    expect((await reconciled).status()).toBe(200);
    expect(await target.count()).toBe(0);
    await page.getByRole('button', { name: 'Dismiss', exact: true }).click();
    await expect.poll(() => page.getByRole('alert').count()).toBe(0);
  } finally {
    gate.resolve();
    refresh.resolve();
    await visit.close();
  }
});
it('E22: a real D1 revoke failure restores the original group and Try again confirms a successful retry', async () => {
  const gate = deferred();
  const refresh = deferred();
  const visit = await machinesPage(browser, {
    configure: async (page, app) => {
      let reads = 0;
      await page.route('**/api/machines', async (route) => {
        if (++reads > 1) await refresh.promise;
        await route.continue();
      });
      const db = await app.mf.getD1Database('DB');
      await db
        .prepare(
          "CREATE TRIGGER revoke_failure BEFORE DELETE ON machine_tokens BEGIN SELECT RAISE(ABORT, 'Synthetic private failure'); END",
        )
        .run();
      await page.route('**/api/machines/*', async (route) => {
        await gate.promise;
        await route.continue();
      });
    },
  });
  const { page, machines } = visit;
  try {
    await confirmRevoke(page, machines[2].id);
    await expect.poll(() => machineRow(page, machines[2].id).count()).toBe(0);
    expect(await page.getByRole('alert').innerText()).not.toContain('Revoked');
    gate.resolve();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain("Couldn't revoke framework-13");
    expect(await page.getByRole('alert').innerText()).toContain(
      'is still connected and its token still works',
    );
    expect(
      await page
        .getByRole('region', { name: 'Not used in 30 days' })
        .locator('[data-machine]')
        .getAttribute('data-machine'),
    ).toBe(machines[2].id);
    expect(await listMachines(visit.app)).toHaveLength(5);
    const reconciled = page.waitForResponse(
      (response) =>
        response.request().method() === 'GET' &&
        new URL(response.url()).pathname === '/api/machines',
    );
    refresh.resolve();
    expect((await reconciled).status()).toBe(200);
    await (await visit.app.mf.getD1Database('DB'))
      .prepare('DROP TRIGGER revoke_failure')
      .run();
    await page
      .getByRole('alert')
      .getByRole('button', { name: 'Try again' })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Revoke machine', exact: true })
      .click();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain('Revoked framework-13');
    expect(await machineRow(page, machines[2].id).count()).toBe(0);
  } finally {
    gate.resolve();
    refresh.resolve();
    await visit.close();
  }
});
it.each(['focus', 'intent'] as const)(
  'E23: a stale %s refetch already in flight never resurrects a pending revoke',
  async (trigger) => {
    const visit = await machinesPage(browser);
    const read = deferred();
    const readReady = deferred();
    const write = deferred();
    const reconcile = deferred();
    const reconcileReady = deferred();
    let reads = 0;
    let activeReads = 0;
    const aborted: string[] = [];
    const { page, machines, requests } = visit;
    try {
      await machineRow(page, machines[2].id).waitFor();
      await page.route('**/api/machines', async (route) => {
        activeReads++;
        try {
          if (++reads > 1) {
            reconcileReady.resolve();
            await reconcile.promise;
          }
          const response = await route.fetch();
          readReady.resolve();
          await read.promise;
          await route.fulfill({ response }).catch(() => {});
        } finally {
          activeReads--;
        }
      });
      await page.route('**/api/machines/*', async (route) => {
        await write.promise;
        await route.continue();
      });
      page.on('requestfailed', (request) => {
        if (new URL(request.url()).pathname === '/api/machines')
          aborted.push(request.failure()?.errorText ?? '');
      });
      if (trigger === 'focus') {
        await page.evaluate(() => {
          window.dispatchEvent(new Event('visibilitychange'));
          window.dispatchEvent(new Event('focus'));
        });
      } else {
        await page
          .getByRole('navigation', { name: 'breadcrumb' })
          .getByRole('link', { name: 'Nook', exact: true })
          .click();
        await page.clock.fastForward(31_000);
        await page.clock.setFixedTime(
          new Date(Date.parse(machinesNow) + 31_000),
        );
        const link = page
          .locator('[data-slot="sidebar-content"]')
          .getByRole('link', { name: 'Machines', exact: true });
        await link.hover();
      }
      await expect
        .poll(
          () =>
            requests.filter(
              (request) =>
                request.method === 'GET' && request.path === '/api/machines',
            ).length,
        )
        .toBe(2);
      await readReady.promise;
      if (trigger === 'intent')
        await page
          .locator('[data-slot="sidebar-content"]')
          .getByRole('link', { name: 'Machines', exact: true })
          .click();
      await confirmRevoke(page, machines[2].id);
      await expect.poll(() => machineRow(page, machines[2].id).count()).toBe(0);
      await expect.poll(() => aborted).toEqual(['net::ERR_ABORTED']);
      read.resolve();
      await page.evaluate(
        () =>
          new Promise<void>((accept) =>
            requestAnimationFrame(() => requestAnimationFrame(() => accept())),
          ),
      );
      expect(await machineRow(page, machines[2].id).count()).toBe(0);
      expect(await page.getByRole('alert').innerText()).toContain('Revoking');
      // Focus and intent while a write is pending must not start another list.
      await page.evaluate(() =>
        window.dispatchEvent(new Event('visibilitychange')),
      );
      await page
        .getByRole('navigation', { name: 'breadcrumb' })
        .getByRole('link', { name: 'Nook', exact: true })
        .click();
      await page.clock.fastForward(31_000);
      await page.clock.setFixedTime(new Date(Date.parse(machinesNow) + 62_000));
      await page
        .locator('[data-slot="sidebar-content"]')
        .getByRole('link', { name: 'Machines', exact: true })
        .hover();
      await page
        .locator('[data-slot="sidebar-content"]')
        .getByRole('link', { name: 'Machines', exact: true })
        .click();
      await expect
        .poll(() => page.getByRole('alert').innerText())
        .toContain('Revoking');
      expect(await machineRow(page, machines[2].id).count()).toBe(0);
      expect(
        requests.filter(
          (request) =>
            request.method === 'GET' && request.path === '/api/machines',
        ),
      ).toHaveLength(2);
      write.resolve();
      await expect
        .poll(() => page.getByRole('alert').innerText())
        .toContain('Revoked');
      await reconcileReady.promise;
    } finally {
      read.resolve();
      write.resolve();
      reconcile.resolve();
      try {
        await page.unrouteAll({ behavior: 'wait' });
        expect(activeReads, 'Routes finish before their context closes').toBe(
          0,
        );
      } finally {
        await visit.close();
      }
    }
  },
);
it('E21/E22: a lost response after committed revocation never claims the token still works and permits idempotent retry', async () => {
  const committed = deferred();
  const release = deferred();
  const visit = await machinesPage(browser, {
    configure: async (page) => {
      await page.route('**/api/machines/*', async (route) => {
        const response = await route.fetch();
        expect(response.status()).toBe(204);
        committed.resolve();
        await release.promise;
        await route.abort('failed');
      });
    },
  });
  const { page, machines } = visit;
  try {
    await confirmRevoke(page, machines[2].id);
    await committed.promise;
    expect(await listMachines(visit.app)).toHaveLength(4);
    release.resolve();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain("Couldn't confirm revocation of framework-13");
    expect(await page.getByRole('alert').innerText()).not.toContain(
      'its token still works',
    );
    expect(await page.getByRole('alert').innerText()).toContain(
      'The connection was interrupted. The machine may already be revoked.',
    );
    await expect.poll(() => machineRow(page, machines[2].id).count()).toBe(0);
    await expect
      .poll(() => page.locator('[data-slot="alert-dialog-overlay"]').count())
      .toBe(0);
    await page.unroute('**/api/machines/*');
    await page
      .getByRole('alert')
      .getByRole('button', { name: 'Try again' })
      .click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Revoke machine', exact: true })
      .click();
    await expect
      .poll(() => page.getByRole('alert').innerText())
      .toContain('Revoked framework-13');
    expect(await machineRow(page, machines[2].id).count()).toBe(0);
  } finally {
    release.resolve();
    await visit.close();
  }
});
it('E24: the empty state teaches the installation reconnect command', async () => {
  const visit = await machinesPage(browser, { seeds: [] });
  try {
    await visit.page
      .getByText('No machines connected', { exact: true })
      .waitFor();
    expect(
      await visit.page.locator('[data-slot="empty-description"]').innerText(),
    ).toContain(
      'To connect a machine, run this on it and approve the request that opens here.',
    );
    expect(await visit.page.locator('code').innerText()).toBe(
      `nook login ${visit.app.origin}`,
    );
  } finally {
    await visit.close();
  }
});
it('E24: loading shows skeleton rows until the real list arrives', async () => {
  const gate = deferred();
  const visit = await machinesPage(browser, {
    configure: async (page) => {
      await page.route('**/api/machines', async (route) => {
        await gate.promise;
        await route.continue();
      });
    },
  });
  try {
    const loading = visit.page.getByRole('status', {
      name: 'Loading machines',
    });
    await loading.waitFor();
    expect(
      await loading.locator('[data-slot="skeleton"]').count(),
    ).toBeGreaterThanOrEqual(9);
    expect(await visit.page.locator('[data-machine]').count()).toBe(0);
    gate.resolve();
    await machineRow(visit.page, visit.machines[0].id).waitFor();
    expect(await loading.count()).toBe(0);
  } finally {
    gate.resolve();
    await visit.close();
  }
});
it('E24: a real list failure offers Try again and recovers the existing approvals', async () => {
  const visit = await machinesPage(browser, {
    configure: async (_page, app) => {
      await (await app.mf.getD1Database('DB'))
        .prepare(
          'ALTER TABLE machine_tokens RENAME TO unavailable_machine_tokens',
        )
        .run();
    },
  });
  try {
    await visit.page
      .getByText("Couldn't load machines", { exact: true })
      .waitFor();
    expect(await visit.page.locator('[data-machine]').count()).toBe(0);
    await (await visit.app.mf.getD1Database('DB'))
      .prepare(
        'ALTER TABLE unavailable_machine_tokens RENAME TO machine_tokens',
      )
      .run();
    await visit.page.getByRole('button', { name: 'Try again' }).click();
    await machineRow(visit.page, visit.machines[0].id).waitFor();
    expect(
      await visit.page
        .getByText("Couldn't load machines", { exact: true })
        .count(),
    ).toBe(0);
  } finally {
    await visit.close();
  }
});
it.each(['hover', 'focus'] as const)(
  'E25: %s preloads Machines code and one cached list reused by Home navigation',
  async (intent) => {
    const visit = await machinesPage(browser, { start: '/' });
    try {
      const link = visit.page
        .getByRole('region', { name: 'Platform' })
        .getByRole('link', { name: /Machines/ });
      await link.waitFor();
      expect(
        visit.requests.filter((request) => request.path === '/api/machines'),
      ).toHaveLength(0);
      await (intent === 'hover' ? link.hover() : link.focus());
      await expect
        .poll(
          () =>
            visit.requests.filter((request) => request.path === '/api/machines')
              .length,
        )
        .toBe(1);
      await expect
        .poll(() =>
          visit.requests.some((request) => /machines.*\.js/.test(request.path)),
        )
        .toBe(true);
      await link.click();
      await machineRow(visit.page, visit.machines[0].id).waitFor();
      expect(
        visit.requests.filter((request) => request.path === '/api/machines'),
      ).toHaveLength(1);
    } finally {
      await visit.close();
    }
  },
);
