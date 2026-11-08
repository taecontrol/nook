import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { expect, it } from 'vitest';
import {
  app,
  configure,
  keyring,
  setupAgentCreateCli,
} from './support/agent-create-cli.ts';
import { acmePath, auditPageData, auditRows } from './support/audit.ts';
import { deferred } from './support/machines.ts';
import { decide, setMark, view } from './support/owner-approval.ts';
import { createSecret, expectNoValue, secretInput } from './support/vault.ts';

setupAgentCreateCli();
const args = (script = 'process.stdout.write("started")') => [
  'run',
  '--secret',
  `T=${acmePath}`,
  '--purpose',
  'owner approval acceptance',
  '--',
  process.execPath,
  '-e',
  script,
];
async function startWaiting() {
  const input = secretInput({ name: 'GH_TOKEN' });
  expect((await createSecret(app, input)).status).toBe(201);
  await setMark(app);
  const running = keyring.start(args(), { CLAUDE_CODE_SESSION_ID: 's1' });
  await expect
    .poll(() => /\/approvals\/[0-9a-f-]+/.test(running.output()))
    .toBe(true);
  const id = /\/approvals\/([0-9a-f-]+)/.exec(running.output())?.[1] ?? '';
  return { input, running, id };
}
it('E6/E7/E13/E30: the real CLI waits privately, delivers the exact value, propagates child exit and silently reuses across agents', async () => {
  const input = secretInput({ name: 'GH_TOKEN' });
  await createSecret(app, input);
  await setMark(app);
  const digest = createHash('sha256').update(input.value).digest('hex');
  const script = `const {createHash}=require('node:crypto');process.stdout.write(String(createHash('sha256').update(process.env.T).digest('hex')===${JSON.stringify(digest)}));process.exitCode=42`;
  const running = keyring.start(args(script), { CLAUDE_CODE_SESSION_ID: 's1' });
  let finished = false;
  void running.done.then(() => {
    finished = true;
  });
  await expect
    .poll(() => /\/approvals\/[0-9a-f-]+/.test(running.output()))
    .toBe(true);
  expect(running.output()).toContain(acmePath);
  expect(running.output()).toMatch(/\d+:\d{2} left/);
  expect(finished, 'The CLI waits for the owner').toBe(false);
  const id = /\/approvals\/([0-9a-f-]+)/.exec(running.output())?.[1] ?? '';
  expect((await auditRows(app)).map((r) => r.outcome)).toEqual([
    'approval_requested',
  ]);
  expect((await decide(app, id, '1h')).status).toBe(200);
  const result = await running.done;
  expect(result.status).toBe(42);
  expect(result.stdout).toBe('true');
  expectNoValue(result.stderr, [input.value]);
  const next = await keyring.start(args(script), { CODEX_SESSION_ID: 'c1' })
    .done;
  expect(next.status).toBe(42);
  expect(next.stdout).toBe('true');
  expect(next.stderr).toBe('');
  expect(
    (await auditPageData(app)).entries.filter((r) => r.outcome === 'delivered'),
  ).toHaveLength(2);
});
it('E8: denying the real waiting CLI prints nothing delivered and exits 77 without starting its command', async () => {
  const { input, running, id } = await startWaiting();
  await decide(app, id, 'deny');
  const result = await running.done;
  expect(result.status).toBe(77);
  expect(result.stdout).not.toContain('started');
  expect(result.stderr).toContain('Nothing was delivered.');
  expectNoValue(result.stderr, [input.value]);
});
it.each([
  ['SIGINT', 130],
  ['SIGTERM', 143],
] as const)(
  'E10: %s withdraws the real pending request and exits %i before any child exists',
  async (signal, code) => {
    const { running, id } = await startWaiting();
    expect(await running.kill(signal)).toBe(true);
    expect((await running.done).status).toBe(code);
    expect(await view(app, id)).toMatchObject({ state: 'withdrawn' });
    expect((await decide(app, id)).status).toBe(409);
  },
);
async function fakeValues(
  answer: (
    call: number,
    payload: Record<string, unknown>,
  ) =>
    | { status: number; body: unknown }
    | null
    | Promise<{ status: number; body: unknown } | null>,
) {
  const bodies: Record<string, unknown>[] = [];
  const withdrawals: string[] = [];
  const server = createServer(async (request, response) => {
    let text = '';
    for await (const chunk of request) text += String(chunk);
    if (!request.url?.endsWith('/values')) {
      if (request.method === 'DELETE') withdrawals.push(request.url ?? '');
      response.writeHead(204).end();
      return;
    }
    const body = JSON.parse(text) as Record<string, unknown>;
    bodies.push(body);
    const result = await answer(bodies.length, body);
    if (!result) {
      response.destroy();
      return;
    }
    response.writeHead(result.status, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify(result.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('No synthetic port');
  const origin = `http://127.0.0.1:${address.port}`;
  await configure(origin);
  return {
    bodies,
    withdrawals,
    close: () =>
      new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      ),
  };
}
// expiresAt lies an hour ahead, so only the relative expiresIn can end the
// wait within the test. A far-future date would overflow a timer and fire at
// once, hiding a deadline taken from expiresAt.
const shortPending = {
  approval: {
    id: '00000000-0000-4000-8000-000000000001',
    url: 'https://nook.test/approvals/request',
    paths: [acmePath],
    expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    expiresIn: 1,
    interval: 2,
  },
};
it.each([
  ['SIGINT', 130, 'pending'],
  ['SIGTERM', 143, 'pending'],
  ['SIGINT', 130, 'values'],
  ['SIGTERM', 143, 'values'],
] as const)(
  '%s during the first values request exits %i after its %s answer and starts no child',
  async (signal, code, answer) => {
    const reached = deferred();
    const release = deferred();
    const fake = await fakeValues(async () => {
      reached.resolve();
      await release.promise;
      return {
        status: 200,
        body:
          answer === 'pending'
            ? shortPending
            : { values: [{ path: acmePath, value: 'synthetic-only' }] },
      };
    });
    const running = keyring.start(args());
    try {
      await reached.promise;
      expect(await running.kill(signal)).toBe(true);
      // Keep the response in flight while Node handles the signal. Cancellation
      // must not abandon a server-created request whose id is not known yet.
      const exitedEarly = await Promise.race([
        running.done.then(() => true),
        new Promise<boolean>((resolve) =>
          setTimeout(() => resolve(false), 100),
        ),
      ]);
      expect.soft(exitedEarly).toBe(false);
      release.resolve();
      const result = await running.done;
      expect.soft(result.status).toBe(code);
      expect.soft(result.stdout).toBe('');
      expectNoValue(result.stderr, ['synthetic-only']);
      expect.soft(fake.bodies).toHaveLength(1);
      expect
        .soft(fake.withdrawals)
        .toEqual(
          answer === 'pending'
            ? [`/api/machine/approvals/${shortPending.approval.id}`]
            : [],
        );
    } finally {
      release.resolve();
      await running.done;
      await fake.close();
    }
  },
);
it('E9/E11: a server unreachable after the pending answer still ends at the relative local deadline with run-again guidance', async () => {
  // Later pending answers would shorten the deadline again, so only the first
  // answer's expiresIn can end this wait.
  const fake = await fakeValues((call) =>
    call === 1
      ? {
          status: 200,
          body: { approval: { ...shortPending.approval, expiresIn: 3 } },
        }
      : null,
  );
  try {
    const result = await keyring.start(args()).done;
    expect(result.status).toBe(75);
    expect(result.stdout).not.toContain('started');
    expect(result.stderr).toContain('Run again to ask again');
    expect(fake.bodies.length).toBeGreaterThan(1);
  } finally {
    await fake.close();
  }
});
it('E11/E19: transient wait failures retry the identical attempt, then delivery starts the command', async () => {
  const fake = await fakeValues((call) =>
    call === 1
      ? {
          status: 200,
          body: { approval: { ...shortPending.approval, expiresIn: 10 } },
        }
      : call === 2
        ? null
        : {
            status: 200,
            body: { values: [{ path: acmePath, value: 'synthetic-only' }] },
          },
  );
  try {
    const result = await keyring.start(args()).done;
    expect(result.status).toBe(0);
    expect(result.stdout).toBe('started');
    expect(fake.bodies).toHaveLength(3);
    expect(fake.bodies[0]).toHaveProperty('approval.attemptId');
    expect(fake.bodies[1]).toEqual(fake.bodies[0]);
    expect(fake.bodies[2]).toEqual(fake.bodies[0]);
  } finally {
    await fake.close();
  }
});
it.each([false, true])(
  'changed coverage exits 75 with run-again guidance and no child (after pending: %s)',
  async (afterPending) => {
    const fake = await fakeValues((call) =>
      afterPending && call === 1
        ? {
            status: 200,
            body: { approval: { ...shortPending.approval, expiresIn: 3 } },
          }
        : { status: 410, body: { _tag: 'ApprovalExpired', reason: 'changed' } },
    );
    try {
      const result = await keyring.start(args()).done;
      expect.soft(result.status).toBe(75);
      expect.soft(result.stdout).toBe('');
      expect
        .soft(result.stderr)
        .toMatch(
          /The secrets that need approval changed while you waited\. Run again to ask again\.\n$/,
        );
      expect(fake.bodies).toHaveLength(afterPending ? 2 : 1);
    } finally {
      await fake.close();
    }
  },
);
it.each([
  {
    tag: 'ApprovalExpired',
    code: 75,
    message: 'Run again to ask again',
    // The local deadline lies beyond the test, so only the 410 ends the wait.
    answer: (call: number) =>
      call === 1
        ? {
            status: 200,
            body: { approval: { ...shortPending.approval, expiresIn: 600 } },
          }
        : { status: 410, body: { _tag: 'ApprovalExpired', reason: 'expired' } },
    asks: 2,
  },
  {
    tag: 'ApprovalLimit',
    code: 75,
    message: 'Too many pending requests.',
    answer: () => ({
      status: 429,
      body: { _tag: 'ApprovalLimit', message: 'Too many pending requests.' },
    }),
    asks: 1,
  },
] as const)(
  'E9/E28: $tag maps to exit $code and its public reason',
  async ({ code, message, answer, asks }) => {
    const fake = await fakeValues(answer);
    try {
      const result = await keyring.start(args()).done;
      expect(result.status).toBe(code);
      expect(result.stderr).toContain(message);
      expect(result.stdout).not.toContain('started');
      expect(fake.bodies, 'The refusal is not retried').toHaveLength(asks);
    } finally {
      await fake.close();
    }
  },
);
