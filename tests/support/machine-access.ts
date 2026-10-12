import type { BucketGrant } from '@nook/contract';
import type { Browser, Page } from 'playwright';
import { jsonRequest } from './authorizations.ts';
import { grantTree, seedGrantTree } from './grants.ts';
import { type ListedMachine, manyMachines } from './machines.ts';
import { machineRow, machinesPage } from './machines-browser.ts';
import type { TestRuntime } from './runtime.ts';

export function saveAccess(
  app: TestRuntime,
  id: string,
  grant: unknown,
  previous: unknown,
  headers: Record<string, string> = {},
) {
  return jsonRequest(
    app,
    `/api/machines/${encodeURIComponent(id)}/grant`,
    { grant, previous },
    headers,
    'PUT',
  );
}

export const accessMachines = [
  ...manyMachines.slice(0, 5),
  {
    name: 'thinkpad-x1',
    approvedAt: '2026-09-01T08:00:00.000Z',
    lastUsedAt: '2026-10-05T12:00:00.000Z',
  },
  {
    name: 'framework-13-ryzen-ai-hx-370-home-office-standing-desk-primary-1',
    approvedAt: '2026-09-02T08:00:00.000Z',
    lastUsedAt: '2026-10-05T13:00:00.000Z',
  },
];
export const accessGrants: BucketGrant[] = [
  ['work/acme'],
  'all',
  ['personal/finances'],
  ['clients/acme-logistics', 'work/taecontrol/nook'],
  ['personal/finances'],
  ['work/acme', 'work/old-experiment'],
  ['personal/health', 'work/acme/api', 'work/acme/web'],
];

export async function seedAccess(app: TestRuntime) {
  await seedGrantTree(app, [
    ...grantTree,
    'work/beta',
    'work/taecontrol/money',
  ]);
  const db = await app.mf.getD1Database('DB');
  await db.batch(
    accessMachines.map((machine, index) =>
      db
        .prepare(
          'UPDATE machine_tokens SET grant_json=? WHERE machine_name=? AND created_at=?',
        )
        .bind(
          JSON.stringify(accessGrants[index]),
          machine.name,
          Date.parse(machine.approvedAt),
        ),
    ),
  );
}

export function accessPage(
  browser: Browser,
  options: {
    viewport?: { width: number; height: number };
    configure?: (page: Page, app: TestRuntime) => Promise<void>;
  } = {},
) {
  return machinesPage(browser, {
    seeds: accessMachines,
    viewport: options.viewport ?? { width: 1280, height: 900 },
    configure: async (page, app) => {
      await seedAccess(app);
      await options.configure?.(page, app);
    },
  });
}

export async function editAccess(page: Page, machine: ListedMachine) {
  await machineRow(page, machine.id)
    .getByRole('button', { name: /Edit access/ })
    .click();
  const sheet = page.getByRole('dialog', { name: 'Edit access', exact: true });
  await sheet
    .getByRole('checkbox', { name: 'work/acme', exact: true })
    .waitFor();
  return sheet;
}
