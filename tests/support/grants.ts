import type { BucketGrant } from '@nook/contract';
import { expect } from 'vitest';
import { createAuthorization, jsonRequest } from './authorizations.ts';
import { type McpVersion, mcpDriver } from './mcp.ts';
import type { TestRuntime } from './runtime.ts';

export const grantTree = [
  'clients',
  'clients/acme-logistics',
  'me',
  'personal',
  'personal/finances',
  'personal/health',
  'work',
  'work/acme',
  'work/acme/api',
  'work/acme/web',
  'work/taecontrol',
  'work/taecontrol/nook',
];
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
export async function seedGrantTree(app: TestRuntime, paths = grantTree) {
  const db = await app.mf.getD1Database('DB');
  await db.batch(
    paths.map((path) =>
      db
        .prepare(
          'INSERT OR IGNORE INTO buckets(path, created_at) VALUES (?, ?)',
        )
        .bind(path, '2026-10-03T08:00:00.000Z'),
    ),
  );
}
export function approveGrant(app: TestRuntime, code: string, grant: unknown) {
  return jsonRequest(app, `/api/authorizations/${code}/approve`, {
    machineName: 'work-laptop',
    grant,
  });
}
export async function issueGrant(app: TestRuntime, grant: BucketGrant = 'all') {
  const pending = await createAuthorization(app, 'work-laptop');
  expect((await approveGrant(app, pending.userCode, grant)).status).toBe(204);
  const response = await jsonRequest(app, '/api/machine/token', {
    deviceCode: pending.deviceCode,
  });
  expect(response.status).toBe(200);
  return (await response.json()) as {
    token: string;
    machine: string;
    grant: BucketGrant;
  };
}
export function machineMcp(
  app: TestRuntime,
  token?: string,
  version: McpVersion = '2026-07-28',
  headers: Record<string, string> = {},
) {
  return mcpDriver(
    app.origin,
    version,
    {
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...headers,
    },
    (request) => {
      const url = new URL(request.url);
      url.pathname = '/api/machine/mcp';
      return fetch(new Request(url, request));
    },
  );
}
