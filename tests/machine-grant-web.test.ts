import type { Browser } from 'playwright';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { launchTestBrowser } from '../scripts/lib/test-browser.ts';
import { bucketCheck, grantPage, selectDeep } from './support/grant-browser.ts';
import { grantTree, issueGrant, machineMcp } from './support/grants.ts';
import { listMachines } from './support/machines.ts';

let browser: Browser;
let closeBrowser: () => Promise<void>;
beforeAll(async () => {
  ({ browser, close: closeBrowser } = await launchTestBrowser());
});
afterAll(async () => {
  await closeBrowser?.();
});
it('E24: step two puts an expanded bounded checklist between code and name, defaulting only to me', async () => {
  const { page, approvals, reveal, close } = await grantPage(browser);
  try {
    await reveal();
    await bucketCheck(page, 'me').waitFor();
    expect(await page.getByRole('checkbox').count()).toBe(grantTree.length + 1);
    for (const path of grantTree)
      expect(await bucketCheck(page, path).isChecked()).toBe(path === 'me');
    expect(
      await page
        .getByText('Every current and future bucket.', { exact: true })
        .count(),
    ).toBe(1);
    const positions = await page.evaluate(() =>
      ['Code you entered', 'Bucket access', 'Machine name'].map(
        (text) =>
          [...document.querySelectorAll('*')]
            .find((node) => node.textContent === text)
            ?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
      ),
    );
    expect(positions[0] < positions[1] && positions[1] < positions[2]).toBe(
      true,
    );
    expect(
      await page
        .getByRole('group', { name: 'Bucket access', exact: true })
        .evaluate((node) => {
          const style = getComputedStyle(node);
          return (
            ['auto', 'scroll'].includes(style.overflowY) &&
            node.scrollHeight > node.clientHeight
          );
        }),
    ).toBe(true);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(approvals).toEqual([{ machineName: 'omarchy', grant: ['me'] }]);
  } finally {
    await close();
  }
});
it('E25/E26: choosing a parent replaces descendants, labels coverage and read-only paths, and releasing it unhides the choices', async () => {
  const { page, reveal, approvals, close } = await grantPage(browser);
  try {
    await reveal();
    await selectDeep(page);
    await page.getByText('Read only: me, work', { exact: true }).waitFor();
    expect(
      await page
        .locator('[data-grant-path="me"]')
        .locator(':scope > div')
        .getByText('Read only', { exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .locator('[data-grant-path="work"]')
        .getByText('Read only', { exact: true })
        .count(),
    ).toBe(1);
    await bucketCheck(page, 'work').check();
    expect(
      await page
        .locator('[data-grant-path="work"]')
        .getByText('Write', { exact: true })
        .count(),
    ).toBe(1);
    for (const path of grantTree.filter((path) => path.startsWith('work/'))) {
      expect(await bucketCheck(page, path).isChecked()).toBe(true);
      expect(await bucketCheck(page, path).isDisabled()).toBe(true);
      expect(
        await page
          .locator(`[data-grant-path="${path}"]`)
          .locator(':scope > div')
          .getByText('Via work', { exact: true })
          .count(),
      ).toBe(1);
    }
    await page.getByText('Read only: me', { exact: true }).waitFor();
    await bucketCheck(page, 'work').uncheck();
    expect(await bucketCheck(page, 'work/acme').isChecked()).toBe(false);
    expect(await bucketCheck(page, 'work/acme').isEnabled()).toBe(true);
    expect(
      await page
        .locator('[data-grant-path="personal"]')
        .locator(':scope > div')
        .getByText('Hidden', { exact: true })
        .count(),
    ).toBe(1);
    await bucketCheck(page, 'work').check();
    await bucketCheck(page, 'me').check();
    await page.getByText('Read only: none', { exact: true }).waitFor();
    expect(
      await page
        .getByText('All other buckets stay hidden.', { exact: true })
        .count(),
    ).toBe(1);
    expect(
      await page
        .getByText(
          'To change access later, revoke this machine and log in again.',
          { exact: true },
        )
        .count(),
    ).toBe(1);
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(approvals).toEqual([
      { machineName: 'omarchy', grant: ['me', 'work'] },
    ]);
  } finally {
    await close();
  }
});
it('E27: All buckets explicitly covers everything and unchecking restores the previous limited roots', async () => {
  const { page, reveal, approvals, close } = await grantPage(browser);
  try {
    await reveal();
    await selectDeep(page);
    await bucketCheck(page, 'All buckets').check();
    for (const path of grantTree) {
      expect(await bucketCheck(page, path).isChecked()).toBe(true);
      expect(await bucketCheck(page, path).isDisabled()).toBe(true);
    }
    await bucketCheck(page, 'All buckets').uncheck();
    expect(await bucketCheck(page, 'work/acme').isChecked()).toBe(true);
    expect(await bucketCheck(page, 'me').isChecked()).toBe(false);
    await bucketCheck(page, 'All buckets').check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(approvals).toEqual([{ machineName: 'omarchy', grant: 'all' }]);
  } finally {
    await close();
  }
});
it.each(['click', 'Enter'])(
  'E28: an empty selection blocks %s with the exact guidance and no request',
  async (method) => {
    const { page, reveal, approvals, close } = await grantPage(browser);
    try {
      await reveal();
      await bucketCheck(page, 'me').uncheck();
      if (method === 'click')
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .click();
      else
        await page
          .getByRole('textbox', { name: 'Machine name', exact: true })
          .press('Enter');
      await page
        .getByText('Choose at least one bucket.', { exact: true })
        .waitFor();
      expect(approvals).toEqual([]);
    } finally {
      await close();
    }
  },
);
it.each(['loading', 'failed'])(
  'E29: %s buckets disable limited approval including Enter, while All buckets and Deny remain explicit choices',
  async (state) => {
    let release = () => {};
    const held = new Promise<void>((accept) => {
      release = accept;
    });
    const { page, app, reveal, approvals, close } = await grantPage(browser, {
      configure: async (page, app) => {
        if (state === 'failed')
          await (await app.mf.getD1Database('DB'))
            .prepare('ALTER TABLE buckets RENAME TO unavailable_buckets')
            .run();
        else
          await page.route('**/api/buckets', async (route) => {
            await held;
            await route.continue().catch(() => {});
          });
      },
    });
    try {
      await reveal();
      if (state === 'failed')
        await page
          .getByText("Couldn't load buckets", { exact: true })
          .waitFor();
      expect(
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .isDisabled(),
      ).toBe(true);
      await page
        .getByRole('textbox', { name: 'Machine name', exact: true })
        .press('Enter');
      expect(approvals).toEqual([]);
      expect(
        await page
          .getByRole('button', { name: 'Deny', exact: true })
          .isEnabled(),
      ).toBe(true);
      await bucketCheck(page, 'All buckets').check();
      expect(
        await page
          .getByRole('button', { name: 'Approve', exact: true })
          .isEnabled(),
      ).toBe(true);
      await bucketCheck(page, 'All buckets').uncheck();
      if (state === 'failed') {
        await (await app.mf.getD1Database('DB'))
          .prepare('ALTER TABLE unavailable_buckets RENAME TO buckets')
          .run();
        await page
          .getByRole('button', { name: 'Try again', exact: true })
          .click();
      } else release();
      await bucketCheck(page, 'me').waitFor();
      expect(await bucketCheck(page, 'me').isChecked()).toBe(true);
      expect(await bucketCheck(page, 'All buckets').isChecked()).toBe(false);
    } finally {
      release();
      await close();
    }
  },
);
it('E30: failed approval preserves its grant on retry and repeats it in the result card', async () => {
  const { page, app, reveal, approvals, close } = await grantPage(browser);
  try {
    await reveal();
    await selectDeep(page);
    await page.route('**/api/authorizations/*/approve', (route) =>
      route.abort(),
    );
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText("Couldn't reach Nook", { exact: true }).waitFor();
    expect(await bucketCheck(page, 'work/acme').isChecked()).toBe(true);
    await page.unroute('**/api/authorizations/*/approve');
    await page.getByRole('button', { name: 'Try again', exact: true }).click();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(approvals).toEqual(
      Array(2).fill({ machineName: 'omarchy', grant: ['work/acme'] }),
    );
    await page.getByText('Read only: me, work', { exact: true }).waitFor();
    expect(await page.getByText('work/acme', { exact: true }).count()).toBe(1);
    expect(
      (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare('SELECT grant_json FROM authorizations')
          .first()
      )?.grant_json,
    ).toBe('["work/acme"]');
  } finally {
    await close();
  }
});
it('E5: a deleted choice leaves approval pending and asks the owner to choose again from a refreshed tree', async () => {
  const { page, app, reveal, approvals, close } = await grantPage(browser);
  try {
    await reveal();
    await selectDeep(page);
    await (await app.mf.getD1Database('DB'))
      .prepare("DELETE FROM buckets WHERE path LIKE 'work/acme%'")
      .run();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByText(/selected buckets.*choose again/i).waitFor();
    await expect.poll(() => bucketCheck(page, 'work/acme').count()).toBe(0);
    expect(
      (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare('SELECT status FROM authorizations')
          .first()
      )?.status,
    ).toBe('pending');
    await bucketCheck(page, 'work').check();
    await page.getByRole('button', { name: 'Approve', exact: true }).click();
    await page.getByRole('heading', { name: 'Machine approved' }).waitFor();
    expect(approvals.at(-1)).toEqual({
      machineName: 'omarchy',
      grant: ['work'],
    });
  } finally {
    await close();
  }
});
it('E16/E17/E31: Machines shows grants and MCP last use, wraps long roots on a phone, and revocation denies the next call', async () => {
  const { page, app, close } = await grantPage(browser, {
    viewport: { width: 390, height: 844 },
  });
  try {
    const deep =
      'work/clients/municipal-water-authority-ops/infrastructure/terraform/backups';
    const db = await app.mf.getD1Database('DB');
    for (const path of [
      'work/clients',
      'work/clients/municipal-water-authority-ops',
      'work/clients/municipal-water-authority-ops/infrastructure',
      'work/clients/municipal-water-authority-ops/infrastructure/terraform',
      deep,
    ])
      await db
        .prepare('INSERT INTO buckets(path, created_at) VALUES (?, ?)')
        .bind(path, '2026-10-03T08:00:00.000Z')
        .run();
    const grant = [
      'me',
      'personal/finances',
      'personal/health',
      'clients/acme-logistics',
      deep,
    ];
    const { token } = await issueGrant(app, grant);
    const [machine] = await listMachines(app);
    await machineMcp(app, token).call('list_buckets');
    await page.goto(`${app.origin}/machines`);
    const row = page.locator(`[data-machine="${machine.id}"]`);
    await row.waitFor();
    const text = await row.innerText();
    expect(text).toContain('Last used just now');
    expect(text).toContain(
      '(read/write, including current and future descendants).',
    );
    expect(text).toContain('Read only:');
    expect(text).toContain(
      'Read only: clients, personal, work, work/clients, work/clients/municipal-water-authority-ops, work/clients/municipal-water-authority-ops/infrastructure, work/clients/municipal-water-authority-ops/infrastructure/terraform',
    );
    expect(text).toContain('All other buckets stay hidden.');
    for (const root of grant) expect(text).toContain(root);
    expect(
      await row
        .locator('[data-slot="item-description"]')
        .last()
        .evaluate((node) => node.scrollHeight <= node.clientHeight),
      'The entire access text is visible without truncation',
    ).toBe(true);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBe(true);
    await row.getByRole('button', { name: /Revoke/ }).click();
    await page
      .getByRole('alertdialog')
      .getByRole('button', { name: 'Revoke machine', exact: true })
      .click();
    await page.getByText('Revoked work-laptop', { exact: true }).waitFor();
    expect((await machineMcp(app, token).request('tools/list')).status).toBe(
      401,
    );
  } finally {
    await close();
  }
});
it('E32: step one preloads buckets and accepting the code reuses them without a second request', async () => {
  let loads = 0;
  const { page, reveal, close } = await grantPage(browser, {
    configure: async (page) => {
      page.on('request', (request) => {
        if (request.url().endsWith('/api/buckets')) loads++;
      });
    },
  });
  try {
    await expect.poll(() => loads).toBe(1);
    await page.waitForLoadState('networkidle');
    await reveal();
    await bucketCheck(page, 'work/acme/api').waitFor();
    expect(loads).toBe(1);
    expect(
      await page.getByRole('status', { name: 'Loading buckets' }).count(),
    ).toBe(0);
  } finally {
    await close();
  }
});
