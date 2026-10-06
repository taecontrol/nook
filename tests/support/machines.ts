import { createHash } from 'node:crypto';
import type { BucketGrant } from '@nook/contract';
import { expect } from 'vitest';
import { issueToken } from './authorizations.ts';
import type { TestRuntime } from './runtime.ts';

export type ListedMachine = {
  id: string;
  name: string;
  approvedAt: string;
  lastUsedAt: string | null;
  grant: BucketGrant;
};
export type MachineSeed = Omit<ListedMachine, 'id' | 'grant'>;
export const machinesNow = '2026-10-05T15:00:00.000Z';
export const typicalMachines: MachineSeed[] = [
  {
    name: 'framework-13',
    approvedAt: '2026-10-04T09:12:00.000Z',
    lastUsedAt: '2026-10-05T14:58:00.000Z',
  },
  {
    name: 'omarchy-desktop',
    approvedAt: '2026-09-12T18:40:00.000Z',
    lastUsedAt: '2026-10-05T11:03:00.000Z',
  },
  {
    name: 'framework-13',
    approvedAt: '2026-07-28T16:05:00.000Z',
    lastUsedAt: '2026-08-14T10:22:00.000Z',
  },
  {
    name: 'build-server',
    approvedAt: '2026-08-30T08:00:00.000Z',
    lastUsedAt: '2026-10-01T03:00:00.000Z',
  },
  {
    name: 'hetzner-vps',
    approvedAt: '2026-10-05T14:41:00.000Z',
    lastUsedAt: null,
  },
];
export const longMachineName =
  'framework-13-ryzen-ai-hx-370-home-office-standing-desk-primary-1';
export const manyMachines: MachineSeed[] = [
  ...typicalMachines,
  {
    name: 'thinkpad-x1',
    approvedAt: '2025-11-03T10:15:00.000Z',
    lastUsedAt: '2026-03-18T19:47:00.000Z',
  },
  {
    name: 'raspberry-pi-garage',
    approvedAt: '2026-01-20T12:00:00.000Z',
    lastUsedAt: '2026-09-29T06:30:00.000Z',
  },
  {
    name: 'ci-runner-01',
    approvedAt: '2026-05-02T09:30:00.000Z',
    lastUsedAt: '2026-10-05T13:47:00.000Z',
  },
  {
    name: longMachineName,
    approvedAt: '2026-06-10T07:55:00.000Z',
    lastUsedAt: '2026-07-02T21:14:00.000Z',
  },
  {
    name: 'arch-mini-pc',
    approvedAt: '2026-02-14T17:20:00.000Z',
    lastUsedAt: null,
  },
  {
    name: 'nas-backup',
    approvedAt: '2026-09-20T08:45:00.000Z',
    lastUsedAt: null,
  },
  {
    name: 'dev-container',
    approvedAt: '2026-04-11T15:10:00.000Z',
    lastUsedAt: '2026-09-02T11:05:00.000Z',
  },
];

export async function listMachines(
  app: TestRuntime,
  headers: HeadersInit = {},
) {
  const response = await fetch(`${app.origin}/api/machines`, { headers });
  expect(response.status, 'The owner machine list must exist').toBe(200);
  return ((await response.json()) as { machines: ListedMachine[] }).machines;
}
export function revokeMachine(
  app: TestRuntime,
  id: string,
  headers: HeadersInit = {},
) {
  return fetch(`${app.origin}/api/machines/${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers,
  });
}
export function machineIdentity(app: TestRuntime, token: string) {
  return fetch(`${app.origin}/api/machine/whoami`, {
    headers: { Authorization: `Bearer ${token}` },
  });
}
export async function tokenHash(app: TestRuntime, token: string) {
  const hash = createHash('sha256').update(token).digest('hex');
  const db = await app.mf.getD1Database('DB');
  const row = await db
    .prepare('SELECT token_hash FROM machine_tokens WHERE token_hash=?')
    .bind(hash)
    .first<{ token_hash: string }>();
  expect(Boolean(row), 'The issued credential exists in D1').toBe(true);
  return hash;
}
export function expectPrivate(text: string, secrets: readonly string[]) {
  expect(
    secrets.some((secret) => text.includes(secret)),
    'Credentials must never appear in public diagnostics',
  ).toBe(false);
}
export async function tokenSnapshot(app: TestRuntime) {
  return JSON.stringify(
    (
      await (
        await app.mf.getD1Database('DB')
      )
        .prepare('SELECT * FROM machine_tokens ORDER BY token_hash')
        .all()
    ).results,
  );
}
export async function seedMachines(
  app: TestRuntime,
  seeds: readonly MachineSeed[] = typicalMachines,
) {
  const db = await app.mf.getD1Database('DB');
  await db.prepare('DELETE FROM machine_tokens').run();
  const machines: ListedMachine[] = [];
  for (const seed of seeds) {
    const issued = await issueToken(app, seed.name);
    const hash = await tokenHash(app, issued.token);
    const row = await db
      .prepare(
        'UPDATE machine_tokens SET created_at=?, last_used_at=? WHERE token_hash=? RETURNING id',
      )
      .bind(
        Date.parse(seed.approvedAt),
        seed.lastUsedAt === null ? null : Date.parse(seed.lastUsedAt),
        hash,
      )
      .first<{ id: string }>();
    if (!row?.id)
      throw new Error(
        'The machine fixture requires an issued public identifier.',
      );
    machines.push({
      ...seed,
      id: row.id,
      grant: 'all',
    });
  }
  return machines;
}
export function deferred() {
  let resolve = () => {};
  const promise = new Promise<void>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
