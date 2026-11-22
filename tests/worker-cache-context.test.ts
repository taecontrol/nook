import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { authenticate } from '../apps/worker/src/auth.ts';
import worker from '../apps/worker/src/index.ts';
import { issueToken } from './support/authorizations.ts';
import { vaultRuntime } from './support/vault.ts';

vi.mock('../apps/worker/src/auth.ts', () => ({ authenticate: vi.fn() }));

type Bindings = Parameters<typeof worker.fetch>[1];
const apps: Awaited<ReturnType<typeof vaultRuntime>>[] = [];
beforeEach(() => {
  vi.mocked(authenticate).mockResolvedValue({
    email: 'first@nook.test',
    grant: 'all',
  });
});
afterEach(async () => {
  for (const app of apps.splice(0)) await app.close();
});

async function fixture() {
  const app = await vaultRuntime();
  apps.push(app);
  const env: Bindings = {
    ...app.bindings,
    DB: await app.mf.getD1Database('DB'),
  };
  const send = (path: string, init?: RequestInit, next = env) =>
    worker.fetch(new Request(app.origin + path, init), next);
  return { app, env, send };
}

it('warm owner handlers follow changes to the authenticated email and grant', async () => {
  const { send } = await fixture();
  expect(await (await send('/api/whoami')).json()).toEqual({
    email: 'first@nook.test',
  });
  vi.mocked(authenticate).mockResolvedValue({
    email: 'second@nook.test',
    grant: 'all',
  });
  expect(await (await send('/api/whoami')).json()).toEqual({
    email: 'second@nook.test',
  });
  vi.mocked(authenticate).mockResolvedValue({
    email: 'second@nook.test',
    grant: ['work/acme'],
  });
  const response = await send('/api/buckets');
  expect(response.status).toBe(200);
  const body = (await response.json()) as { buckets: { path: string }[] };
  expect(body.buckets.map((bucket) => bucket.path)).toEqual([
    'me',
    'work',
    'work/acme',
    'work/acme/billing-service',
  ]);
  expect((await send('/api/memories?bucket=personal')).status).toBe(403);
});

it('warm owner and machine handlers use the current database binding', async () => {
  const first = await fixture();
  const second = await fixture();
  const firstToken = await issueToken(first.app, 'first-machine');
  const secondToken = await issueToken(second.app, 'second-machine');
  const list = async (env: Bindings) => {
    const response = await first.send('/api/machines', undefined, env);
    expect(response.status).toBe(200);
    return response.json();
  };
  expect(await list(first.env)).toMatchObject({
    machines: [{ name: 'first-machine' }],
  });
  expect(await list(second.env)).toMatchObject({
    machines: [{ name: 'second-machine' }],
  });
  const identity = (env: Bindings, token: string) =>
    first.send(
      '/api/machine/whoami',
      { headers: { Authorization: `Bearer ${token}` } },
      env,
    );
  expect(await (await identity(first.env, firstToken.token)).json()).toEqual({
    machine: 'first-machine',
    grant: 'all',
    expiresAt: null,
  });
  expect(await (await identity(second.env, secondToken.token)).json()).toEqual({
    machine: 'second-machine',
    grant: 'all',
    expiresAt: null,
  });
  expect((await identity(second.env, firstToken.token)).status).toBe(401);
});

it('warm machine authorization handlers advertise the current request origin', async () => {
  const { env } = await fixture();
  for (const origin of [
    'https://first.nook.test',
    'https://second.nook.test',
  ]) {
    const response = await worker.fetch(
      new Request(`${origin}/api/machine/authorizations`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestedName: 'machine', client: 'test' }),
      }),
      env,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      verificationUrl: `${origin}/cli/authorize`,
    });
  }
});
