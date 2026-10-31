import { expect, it } from 'vitest';
import {
  createArgs,
  createdPath,
  createTransport,
} from './support/agent-create.ts';
import {
  app,
  configure,
  keyring,
  setupAgentCreateCli,
  token,
  unconfirmed,
} from './support/agent-create-cli.ts';
import { auditRows } from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { expectOutput } from './support/private-assertions.ts';
import {
  expectNoValue,
  replaceSecret,
  secretInput,
  secretRows,
} from './support/vault.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

setupAgentCreateCli();
it.each(['before', 'after'])(
  'E14/E15: retry a checkpoint failure %s the atomic batch with one row and audit',
  async (stage) => {
    let active = false;
    let failed = false;
    const measured = await vaultCheckpoints(async (label) => {
      if (active && !failed && label === `/${stage}-batch`) {
        failed = true;
        return false;
      }
      return true;
    });
    try {
      const credential = (await issueGrant(measured, ['work/acme'])).token;
      await configure(measured.origin, credential);
      active = true;
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(failed).toBe(true);
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout + result.stderr,
        `Stored ${createdPath}.`,
        true,
      );
      expect(await secretRows(measured)).toHaveLength(1);
      expect(await auditRows(measured)).toHaveLength(1);
    } finally {
      await measured.close();
    }
  },
);
it.each(['lost', 'hang', '503', 'unknown-500', 'unknown-5xx', 'committed'])(
  'E14/E15: %s retries reuse one UUID v4 and an identical payload',
  async (mode) => {
    const transport = await createTransport(
      app,
      (attempt) =>
        attempt > 1 || mode === 'committed'
          ? undefined
          : mode === 'lost' || mode === 'hang'
            ? mode
            : {
                status:
                  mode === '503' ? 503 : mode === 'unknown-500' ? 500 : 502,
                body: {
                  _tag:
                    mode === '503' ? 'ServiceUnavailable' : 'FutureTransient',
                },
              },
      async (attempt, response) => {
        expect(response.status).toBe(201);
        return mode === 'committed' && attempt === 1 ? 'lost' : undefined;
      },
    );
    try {
      await configure(transport.origin);
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(result.status).toBe(0);
      expectOutput(
        result.stdout + result.stderr,
        `Stored ${createdPath}.`,
        true,
      );
      expect(transport.bodies.length).toBe(2);
      expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
      let body: { writeId?: unknown };
      try {
        body = JSON.parse(transport.bodies[0].toString());
      } catch {
        throw new Error('Creation requests must contain valid JSON.');
      }
      expect(
        typeof body.writeId === 'string' &&
          /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
            body.writeId,
          ),
      ).toBe(true);
      expect(await secretRows(app)).toHaveLength(1);
      expect(await auditRows(app)).toHaveLength(1);
    } finally {
      await transport.close();
    }
  },
);
it('E16: a committed lost response followed by owner replacement remains unconfirmed', async () => {
  const transport = await createTransport(
    app,
    () => undefined,
    async (attempt, response) => {
      if (attempt !== 1) return;
      expect(response.status).toBe(201);
      const row = (await secretRows(app))[0];
      expect(
        (
          await replaceSecret(app, createdPath, {
            ...secretInput(),
            expectedVersion: row.version,
          })
        ).status,
      ).toBe(200);
      return 'lost';
    },
  );
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, unconfirmed, true);
    expect(transport.bodies.length).toBe(2);
    expect(await auditRows(app)).toHaveLength(1);
  } finally {
    await transport.close();
  }
});
it('E14/E15: an opened error body stays within the request timeout before replaying the identical payload', async () => {
  const transport = await createTransport(app, (attempt) =>
    attempt === 1 ? 'open-error-body' : undefined,
  );
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    await configure(transport.origin);
    const command = keyring.start(createArgs(), {}, secretInput().value);
    let timedOut = false;
    deadline = setTimeout(() => {
      timedOut = true;
      command.kill('SIGKILL');
    }, 20_000);
    const result = await command.done;
    expect({
      withinDeadline: !timedOut,
      status: result.status,
      requests: transport.bodies.length,
      stored: (await secretRows(app)).length,
      audits: (await auditRows(app)).length,
    }).toEqual({
      withinDeadline: true,
      status: 0,
      requests: 2,
      stored: 1,
      audits: 1,
    });
    expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
    expectOutput(result.stdout + result.stderr, `Stored ${createdPath}.`, true);
  } finally {
    clearTimeout(deadline);
    await transport.close();
  }
});
it('E15: a committed response cut after 201 headers replays the identical payload and confirms once', async () => {
  const transport = await createTransport(
    app,
    () => undefined,
    async (attempt, response) => {
      expect(response.status).toBe(201);
      return attempt === 1 ? 'partial-201' : undefined;
    },
  );
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect({
      status: result.status,
      requests: transport.bodies.length,
      stored: (await secretRows(app)).length,
      audits: (await auditRows(app)).length,
    }).toEqual({ status: 0, requests: 2, stored: 1, audits: 1 });
    expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
    expectOutput(result.stdout + result.stderr, `Stored ${createdPath}.`, true);
  } finally {
    await transport.close();
  }
});
it.each([
  { status: 409, tag: 'SecretExists' },
  { status: 403, tag: 'Forbidden' },
  { status: 404, tag: 'BucketNotFound' },
  { status: 400, tag: 'InvalidSecret' },
  { status: 401, tag: 'Unauthorized' },
  { status: 503, tag: 'VaultNotConfigured' },
])(
  'E16: after an unconfirmed attempt, $tag cannot claim a definitive refusal',
  async ({ status, tag }) => {
    const transport = await createTransport(app, (attempt) =>
      attempt === 1
        ? 'lost'
        : { status, body: { _tag: tag, message: 'definitive refusal' } },
    );
    try {
      await configure(transport.origin);
      const result = await keyring.start(createArgs(), {}, secretInput().value)
        .done;
      expect(result.status).toBe(1);
      expectOutput(result.stdout + result.stderr, unconfirmed, true);
      expect(transport.bodies.length).toBe(2);
    } finally {
      await transport.close();
    }
  },
);
it.each([
  { shape: 'malformed JSON', failures: 1, outcome: 'recovered' },
  { shape: 'invalid metadata', failures: 1, outcome: 'recovered' },
  { shape: 'malformed JSON', failures: 3, outcome: 'unconfirmed' },
  { shape: 'invalid metadata', failures: 3, outcome: 'unconfirmed' },
])(
  'complete 201 $shape: a committed create remains $outcome',
  async ({ shape, failures }) => {
    const value = secretInput().value;
    const rawBody =
      shape === 'malformed JSON'
        ? `{"path":${JSON.stringify(value)}`
        : JSON.stringify({ path: { value } });
    const statuses: number[] = [];
    const transport = await createTransport(
      app,
      () => undefined,
      async (attempt, response) => {
        statuses.push(response.status);
        return attempt <= failures ? { rawBody } : undefined;
      },
    );
    try {
      await configure(transport.origin);
      const result = await keyring.start(createArgs(), {}, value).done;
      expectNoValue(result.stdout + result.stderr, [value, token, app.key]);
      const recovered = failures === 1;
      expect({
        status: result.status,
        requests: transport.bodies.length,
        stored: (await secretRows(app)).length,
        audits: (await auditRows(app)).length,
      }).toEqual({
        status: recovered ? 0 : 1,
        requests: recovered ? 2 : 3,
        stored: 1,
        audits: 1,
      });
      expect(statuses.every((status) => status === 201)).toBe(true);
      expect(
        transport.bodies.every((body) => body.equals(transport.bodies[0])),
      ).toBe(true);
      expectOutput(
        result.stdout,
        recovered ? `Stored ${createdPath}.` : unconfirmed,
        true,
      );
      expectOutput(result.stderr, '', true);
    } finally {
      await transport.close();
    }
  },
);
it('E17: an initial VaultNotConfigured is definitive and is not retried', async () => {
  await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
  const transport = await createTransport(app, () => undefined);
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
      true,
    );
    expect(transport.bodies.length).toBe(1);
  } finally {
    await transport.close();
  }
});
it('E18: exactly three unconfirmed attempts stop with the unconfirmed message', async () => {
  const transport = await createTransport(app, () => ({
    status: 502,
    body: { _tag: 'FutureTransient' },
  }));
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout + result.stderr, unconfirmed, true);
    expect(transport.bodies.length).toBe(3);
    expect(
      transport.bodies.every((body) => body.equals(transport.bodies[0])),
    ).toBe(true);
  } finally {
    await transport.close();
  }
});
it('E19: an unknown definitive tag preserves its public message without retrying', async () => {
  const transport = await createTransport(app, () => ({
    status: 422,
    body: { _tag: 'FutureRefusal', message: 'A future public refusal.' },
  }));
  try {
    await configure(transport.origin);
    const result = await keyring.start(createArgs(), {}, secretInput().value)
      .done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      'A future public refusal.',
      true,
    );
    expect(transport.bodies.length).toBe(1);
  } finally {
    await transport.close();
  }
});
it.each([
  { status: 422, shape: 'invalid JSON', rawBody: '{"_tag":', retry: false },
  { status: 502, shape: 'invalid JSON', rawBody: '{"_tag":', retry: true },
  { status: 422, shape: 'invalid shape', rawBody: '{"_tag":7}', retry: false },
  { status: 502, shape: 'invalid shape', rawBody: '{"_tag":7}', retry: true },
])(
  'HTTP error body: complete $shape $status keeps transport retry policy',
  async ({ status, rawBody, retry }) => {
    const transport = await createTransport(app, (attempt) =>
      attempt === 1 ? { status, body: undefined, rawBody } : undefined,
    );
    try {
      await configure(transport.origin);
      const value = secretInput().value;
      const result = await keyring.start(createArgs(), {}, value).done;
      expectNoValue(result.stdout + result.stderr, [value, token, app.key]);
      expect({
        status: result.status,
        requests: transport.bodies.length,
        stored: (await secretRows(app)).length,
        audits: (await auditRows(app)).length,
      }).toEqual({
        status: retry ? 0 : 1,
        requests: retry ? 2 : 1,
        stored: retry ? 1 : 0,
        audits: retry ? 1 : 0,
      });
      if (retry)
        expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
      expectOutput(
        result.stdout + result.stderr,
        retry
          ? `Stored ${createdPath}.`
          : `Could not reach ${transport.origin}. Try again.`,
        true,
      );
    } finally {
      await transport.close();
    }
  },
);
