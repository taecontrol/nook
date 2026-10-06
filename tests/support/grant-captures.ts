import type { BucketGrant } from '@nook/contract';
import type { Page } from 'playwright';
import { expect } from 'vitest';
import { createAuthorization, jsonRequest } from './authorizations.ts';
import { seedGrantTree } from './grants.ts';
import type { TestRuntime } from './runtime.ts';

export const largeGrantPaths = [
  'work/taecontrol/website',
  'clients/acme-logistics/dispatch',
  'clients/acme-logistics/dispatch/routes',
  'clients/acme-logistics/dispatch/routes/regional',
  'clients/acme-logistics/dispatch/routes/regional/manifests',
  'clients/acme-logistics/invoices',
  'clients/acme-logistics/invoices/archive',
  'clients/river-studio',
  'clients/river-studio/design',
  'clients/river-studio/design/assets',
  'clients/river-studio/website',
  'clients/river-studio/website/content',
  'personal/finances/taxes',
  'personal/finances/taxes/2025',
  'personal/finances/receipts',
  'personal/health/appointments',
  'personal/health/records',
  'personal/travel',
  'personal/travel/bookings',
  'work/acme/platform',
  'work/acme/platform/services',
  'work/acme/platform/services/notifications',
  'work/acme/platform/services/notifications/push-delivery-retry-scheduler-v2',
  'work/acme/platform/services/billing',
  'work/acme/platform/operations',
  'work/acme/api/contracts',
  'work/acme/api/tests',
  'work/acme/web/components',
  'work/acme/web/content',
  'work/taecontrol/nook/docs',
  'work/taecontrol/nook/releases',
  'work/taecontrol/website/content',
  'work/taecontrol/website/assets',
];
export async function grantCaptureMachines(app: TestRuntime, page: Page) {
  const now = Date.parse('2026-10-05T12:00:00Z');
  await page.clock.install({ time: new Date(now) });
  await page.clock.setFixedTime(new Date(now));
  const seeds: {
    name: string;
    grant: BucketGrant;
    approved: string;
    last: number;
  }[] = [
    {
      name: 'omarchy',
      grant: 'all',
      approved: '2026-09-28',
      last: now - 5 * 60_000,
    },
    {
      name: 'work-laptop',
      grant: ['me', 'work'],
      approved: '2026-10-01',
      last: now - 2 * 3_600_000,
    },
    {
      name: 'acme-ci-runner',
      grant: ['work/acme/platform/services/notifications'],
      approved: '2026-09-30',
      last: now - 86_400_000,
    },
    {
      name: 'owner-laptop-with-a-deliberately-long-hostname',
      grant: [
        'clients/acme-logistics',
        'me',
        'personal/finances',
        'work/acme',
        'work/taecontrol/nook',
      ],
      approved: '2026-08-20',
      last: now - 40 * 86_400_000,
    },
  ];
  await seedGrantTree(app, largeGrantPaths);
  for (const seed of seeds) {
    const pending = await createAuthorization(app, seed.name);
    expect(
      (
        await jsonRequest(
          app,
          `/api/authorizations/${pending.userCode}/approve`,
          { machineName: seed.name, grant: seed.grant },
        )
      ).status,
    ).toBe(204);
    expect(
      (
        await jsonRequest(app, '/api/machine/token', {
          deviceCode: pending.deviceCode,
        })
      ).status,
    ).toBe(200);
    await (await app.mf.getD1Database('DB'))
      .prepare(
        'UPDATE machine_tokens SET created_at=?, last_used_at=? WHERE machine_name=?',
      )
      .bind(Date.parse(`${seed.approved}T12:00:00Z`), seed.last, seed.name)
      .run();
  }
}
