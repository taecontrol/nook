import type { D1Database } from '@cloudflare/workers-types';
import { expect } from 'vitest';
import { machineCreateInput } from './agent-create.ts';
import { runInput } from './audit.ts';
import { jsonRequest } from './authorizations.ts';
import { tokenHash } from './machines.ts';
import type { TestRuntime } from './runtime.ts';

export const dayMs = 86_400_000;
export const lifetimes = [
  ['1d', '1 day', dayMs],
  ['7d', '7 days', 7 * dayMs],
  ['30d', '30 days', 30 * dayMs],
  ['90d', '90 days', 90 * dayMs],
  ['never', 'No expiration', null],
] as const;
export async function expiryColumns(db: D1Database) {
  for (const table of ['authorizations', 'machine_tokens']) {
    const rows = await db
      .prepare(`PRAGMA table_info(${table})`)
      .all<{ name: string }>();
    expect(
      rows.results.map((row) => row.name),
      `${table} persists access expiry`,
    ).toContain('access_expires_at');
  }
}
export async function d1Now(app: TestRuntime) {
  return (await (
    await app.mf.getD1Database('DB')
  )
    .prepare("SELECT CAST(unixepoch('subsec')*1000 AS INTEGER) AS now")
    .first<{ now: number }>())!.now;
}
export async function setExpiry(
  app: TestRuntime,
  token: string,
  offset: number | null,
) {
  const db = await app.mf.getD1Database('DB');
  await expiryColumns(db);
  const hash = await tokenHash(app, token);
  const row = await db
    .prepare(
      "UPDATE machine_tokens SET access_expires_at=CASE WHEN ?1 IS NULL THEN NULL ELSE CAST(unixepoch('subsec')*1000 AS INTEGER)+?1 END WHERE token_hash=?2 RETURNING access_expires_at",
    )
    .bind(offset, hash)
    .first<{ access_expires_at: number | null }>();
  return row!.access_expires_at;
}
export function machinePaths(
  value: string,
  id = '00000000-0000-4000-8000-000000000077',
) {
  return [
    { name: 'whoami', method: 'GET', path: '/api/machine/whoami' },
    {
      name: 'secrets',
      method: 'GET',
      path: '/api/machine/secrets?bucket=work/acme',
    },
    {
      name: 'createSecret',
      method: 'POST',
      path: '/api/machine/secrets',
      payload: machineCreateInput({ value }),
    },
    {
      name: 'values',
      method: 'POST',
      path: '/api/machine/secrets/values',
      payload: runInput(),
    },
    {
      name: 'attachFile',
      method: 'PUT',
      path: `/api/machine/memories/${id}/files/proof.txt`,
      bytes: value,
    },
    {
      name: 'downloadFile',
      method: 'GET',
      path: `/api/machine/memories/${id}/files/proof.txt`,
    },
    { name: 'logout', method: 'DELETE', path: '/api/machine/token' },
    {
      name: 'mcp',
      method: 'POST',
      path: '/api/machine/mcp',
      payload: { jsonrpc: '2.0', id: 1, method: 'tools/list' },
    },
  ];
}
export function machineRequest(
  app: TestRuntime,
  token: string,
  route: ReturnType<typeof machinePaths>[number],
) {
  if ('bytes' in route)
    return fetch(app.origin + route.path, {
      method: route.method,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/plain',
      },
      body: route.bytes,
    });
  return jsonRequest(
    app,
    route.path,
    route.payload,
    {
      Authorization: `Bearer ${token}`,
      Accept: 'application/json, text/event-stream',
    },
    route.method,
  );
}
