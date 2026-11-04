import { randomUUID } from 'node:crypto';
import { expect } from 'vitest';
import { acmePath, fetchValues, runFixture } from './audit.ts';
import { jsonRequest } from './authorizations.ts';
import { seedGrantTree } from './grants.ts';
import { filesRuntime } from './memory-files-runtime.ts';
import type { TestRuntime } from './runtime.ts';
import { createSecret, secretInput } from './vault.ts';

export const stripe = 'work/acme/STRIPE_KEY';
export const database = 'work/acme/prod/DATABASE_URL';
export const cloudflare = 'me/nook/CLOUDFLARE_API_TOKEN';
export type Pending = {
  approval: {
    id: string;
    url: string;
    paths: string[];
    expiresAt: string;
    expiresIn: number;
    interval: number;
  };
};
export async function approvalFixture(
  onCheckpoint?: (label: string) => Promise<boolean>,
  clock?: { now: number },
) {
  // Reuse the existing test-only SQLite clock decorator over the built Worker.
  const app = await runFixture(
    'all',
    onCheckpoint,
    clock ? await filesRuntime(clock) : undefined,
  );
  await seedGrantTree(app, ['work/acme/prod', 'work/acme2', 'me/nook']);
  for (const path of [stripe, database, cloudflare, 'work/acme2/TOKEN']) {
    const at = path.lastIndexOf('/');
    expect(
      (
        await createSecret(
          app,
          secretInput({ bucket: path.slice(0, at), name: path.slice(at + 1) }),
        )
      ).status,
    ).toBe(201);
  }
  return app;
}
export function mark(
  app: TestRuntime,
  path = 'work',
  kind = 'bucket',
  method = 'PUT',
) {
  return jsonRequest(
    app,
    `/api/ask-first/${kind}/${encodeURIComponent(path)}`,
    undefined,
    {},
    method,
  );
}
export async function setMark(
  app: TestRuntime,
  path = 'work',
  kind = 'bucket',
) {
  expect(
    (await mark(app, path, kind)).status,
    'The owner can mark a path',
  ).toBe(204);
}
export function ask(
  app: TestRuntime,
  token: string,
  attemptId = randomUUID(),
  overrides: Record<string, unknown> = {},
) {
  return fetchValues(app, token, {
    secrets: [stripe],
    approval: { attemptId },
    ...overrides,
  });
}
export async function pending(
  app: TestRuntime,
  token: string,
  attemptId = randomUUID(),
  overrides: Record<string, unknown> = {},
) {
  const response = await ask(app, token, attemptId, overrides);
  expect(response.status).toBe(200);
  const body = (await response.json()) as Pending;
  expect(body).toHaveProperty('approval.id');
  expect(body).not.toHaveProperty('values');
  return body.approval;
}
export function decide(
  app: TestRuntime,
  id: string,
  remember: 'once' | '1h' | '12h' | 'deny' = 'once',
) {
  return jsonRequest(
    app,
    `/api/approvals/${id}/${remember === 'deny' ? 'deny' : 'approve'}`,
    remember === 'deny' ? undefined : { remember },
    { 'CF-Connecting-IP': '203.0.113.42' },
  );
}
export function withdraw(app: TestRuntime, token: string, id: string) {
  return jsonRequest(
    app,
    `/api/machine/approvals/${id}`,
    undefined,
    { Authorization: `Bearer ${token}` },
    'DELETE',
  );
}
export async function requests(app: TestRuntime) {
  const db = await app.mf.getD1Database('DB');
  const exists = await db
    .prepare("SELECT name FROM sqlite_master WHERE name='approval_requests'")
    .first();
  return exists
    ? (
        await db
          .prepare('SELECT * FROM approval_requests ORDER BY requested_at,id')
          .all<Record<string, unknown>>()
      ).results
    : [];
}
export async function age(
  app: TestRuntime,
  id: string,
  column: 'expires_at' | 'valid_until',
  milliseconds: number,
) {
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(`UPDATE approval_requests SET ${column}=${column}-? WHERE id=?`)
    .bind(milliseconds, id)
    .run();
}
export async function view(app: TestRuntime, id: string) {
  const response = await fetch(`${app.origin}/api/approvals/${id}`);
  expect(response.status).toBe(200);
  return response.json() as Promise<Record<string, unknown>>;
}
export { acmePath };
