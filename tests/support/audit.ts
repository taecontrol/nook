import type { BucketGrant } from '@nook/contract';
import { expect } from 'vitest';
import { jsonRequest } from './authorizations.ts';
import { issueGrant } from './grants.ts';
import { listMachines } from './machines.ts';
import type { TestRuntime } from './runtime.ts';
import {
  createSecret,
  secretInput,
  seedSecrets,
  vaultRuntime,
} from './vault.ts';

export const auditNow = new Date('2026-10-08T12:00:00.000Z');
export const acmePath = 'work/acme/GH_TOKEN';
export type RecordedEntry = {
  id: string;
  at: string;
  outcome: 'delivered' | 'denied';
  path: string;
  bucket: string;
  name: string;
  purpose: string;
  machine: { id: string; name: string };
  workingDirectory: string;
  executable: string;
  runId: string;
};
export function runInput(overrides: Record<string, unknown> = {}) {
  return {
    purpose: 'open the release PR',
    workingDirectory: '/synthetic/work/acme',
    executable: 'gh',
    secrets: [acmePath],
    ...overrides,
  };
}
export function fetchValues(
  app: TestRuntime,
  token?: string,
  overrides: Record<string, unknown> = {},
  headers: Record<string, string> = {},
) {
  return jsonRequest(app, '/api/machine/secrets/values', runInput(overrides), {
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...headers,
  });
}
export async function auditRows(app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  if (
    !(await db
      .prepare("SELECT name FROM sqlite_master WHERE name='audit_entries'")
      .first())
  )
    return [];
  return (
    await db
      .prepare('SELECT * FROM audit_entries ORDER BY at DESC, id DESC')
      .all<Record<string, unknown>>()
  ).results;
}
export async function auditPageData(
  app: TestRuntime,
  query = '',
  headers: Record<string, string> = {},
) {
  const response = await fetch(`${app.origin}/api/audit${query}`, { headers });
  expect(response.status, 'The owner audit page is available').toBe(200);
  return (await response.json()) as {
    entries: RecordedEntry[];
    next: string | null;
  };
}
export async function runFixture(grant: BucketGrant = ['work/acme']) {
  const app = await vaultRuntime();
  const input = secretInput({
    name: 'GH_TOKEN',
    value: `synthetic\n秘密 🔐\r\ntrailing  \t\n`,
  });
  expect((await createSecret(app, input)).status).toBe(201);
  const { token } = await issueGrant(app, grant);
  const [machine] = await listMachines(app);
  return { ...app, input, token, machine };
}
export async function seedAudit(
  app: TestRuntime,
  count = 30,
  grant: BucketGrant = 'all',
) {
  const values = await seedSecrets(app);
  const { token } = await issueGrant(app, grant);
  const paths = [
    acmePath,
    'work/acme/STRIPE_KEY',
    'work/NPM_TOKEN',
    'personal/finances/PLAID_SECRET',
  ];
  const db = await app.mf.getD1Database('DB');
  const recorded = new Set<string>();
  for (let index = 0; index < count; index++) {
    const response = await fetchValues(app, token, {
      secrets: [paths[index % paths.length]],
      purpose: index % 2 ? 'dev server' : 'open the release PR',
      executable: index % 2 ? 'pnpm' : 'gh',
    });
    expect(response.status).toBe(200);
    await response.body?.cancel();
    const row = (await auditRows(app)).find(
      (entry) => !recorded.has(String(entry.id)),
    )!;
    recorded.add(String(row.id));
    await db
      .prepare('UPDATE audit_entries SET at=? WHERE id=?')
      .bind(
        new Date(
          auditNow.getTime() -
            (index < 21
              ? index * 300_000
              : index === 21
                ? 10_800_000
                : (index - 21) * 86_400_000),
        ).toISOString(),
        row.id,
      )
      .run();
  }
  return { values, token, entries: (await auditPageData(app)).entries };
}
