import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { jsonRequest } from './support/authorizations.ts';
import { issueGrant } from './support/grants.ts';
import { deferred } from './support/machines.ts';
import {
  acmePath,
  approvalFixture,
  ask,
  decide,
  mark,
  pending,
  requests,
  setMark,
  stripe,
  view,
  withdraw,
} from './support/owner-approval.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

it('E17: a first request outside the grant is denied before creating any approval', async () => {
  const app = await approvalFixture();
  try {
    await setMark(app);
    const machine = await issueGrant(app, ['me']);
    const response = await ask(app, machine.token);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ _tag: 'SecretsForbidden' });
    expect(await requests(app)).toEqual([]);
    expect((await auditRows(app)).map((row) => row.outcome)).toEqual([
      'denied',
    ]);
  } finally {
    await app.close();
  }
});

it('E21: removing the last mark cannot allow a changed retry payload to deliver or write', async () => {
  const app = await approvalFixture();
  try {
    await setMark(app);
    const id = randomUUID();
    await pending(app, app.token, id);
    await mark(app, 'work', 'bucket', 'DELETE');
    const before = await requests(app);
    const audit = await auditRows(app);
    const response = await ask(app, app.token, id, {
      purpose: 'different retry',
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ _tag: 'InvalidRun' });
    expect(await requests(app)).toEqual(before);
    expect(await auditRows(app)).toEqual(audit);
  } finally {
    await app.close();
  }
});
it.each(['unmarked', 'remembered'] as const)(
  'E21/E25/E26: %s delivery revalidates an attempt created after its read',
  async (route) => {
    let active = false;
    let batches = 0;
    const reached = deferred();
    const resume = deferred();
    const app = await approvalFixture(async (label) => {
      if (active && label === '/before-batch' && ++batches === 2) {
        active = false;
        reached.resolve();
        await resume.promise;
      }
      return true;
    });
    let inFlight: Promise<Response> | undefined;
    try {
      if (route === 'remembered') {
        await setMark(app, stripe, 'secret');
        const remembered = await pending(app, app.token);
        expect((await decide(app, remembered.id, '1h')).status).toBe(200);
      }
      const id = randomUUID();
      const secrets = [stripe, acmePath];
      active = true;
      inFlight = ask(app, app.token, id, { secrets });
      await reached.promise;
      // The competing request creates its row for the same attempt and payload
      // while A waits just before delivery. Removing this mark restores A's
      // snapshot, so only the attempt identity can stop A.
      await setMark(app);
      const competing = await pending(app, app.token, id, { secrets });
      expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
      const before = await requests(app);
      const audit = await auditRows(app);
      resume.resolve();
      const response = await inFlight;
      expect.soft(response.status).toBe(503);
      const body = await response.json();
      expect.soft(body).toMatchObject({
        _tag: 'ServiceUnavailable',
      });
      expect.soft(body).not.toHaveProperty('values');
      expect.soft(await requests(app)).toEqual(before);
      expect.soft(await auditRows(app)).toEqual(audit);

      const retry = await ask(app, app.token, id, { secrets });
      expect(retry.status).toBe(200);
      expect(await retry.json()).toHaveProperty('values');
      expect(await view(app, competing.id)).toMatchObject({
        state: 'settled',
      });
      expect(
        (await auditRows(app))
          .filter((row) => row.outcome === 'delivered')
          .map((row) => row.path)
          .sort(),
      ).toEqual([...secrets].sort());
    } finally {
      resume.resolve();
      await inFlight;
      await app.close();
    }
  },
);
it.each(['remembered approval', 'removed mark'] as const)(
  'E8: an owner denial remains terminal for its attempt despite a %s',
  async (route) => {
    const app = await approvalFixture();
    try {
      await setMark(app);
      const id = randomUUID();
      const first = await pending(app, app.token, id);
      expect((await decide(app, first.id, 'deny')).status).toBe(200);
      if (route === 'remembered approval') {
        const other = await pending(app, app.token);
        expect((await decide(app, other.id, '1h')).status).toBe(200);
      } else {
        expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
      }
      const response = await ask(app, app.token, id);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ _tag: 'ApprovalDenied' });
      expect(
        (await auditRows(app)).some((r) => r.outcome === 'delivered'),
      ).toBe(false);
    } finally {
      await app.close();
    }
  },
);
it.each(['remembered approval', 'removed mark'] as const)(
  'E10: a withdrawn attempt stays expired despite a %s',
  async (route) => {
    const app = await approvalFixture();
    try {
      await setMark(app);
      const id = randomUUID();
      const first = await pending(app, app.token, id);
      expect((await withdraw(app, app.token, first.id)).status).toBe(204);
      if (route === 'remembered approval') {
        const other = await pending(app, app.token);
        expect((await decide(app, other.id, '1h')).status).toBe(200);
      } else {
        expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
      }
      const before = await requests(app);
      const audit = await auditRows(app);
      const response = await ask(app, app.token, id);
      expect(response.status).toBe(410);
      expect(await response.json()).toEqual({
        _tag: 'ApprovalExpired',
        reason: 'withdrawn',
      });
      expect(await requests(app)).toEqual(before);
      expect(await auditRows(app)).toEqual(audit);
      expect(await view(app, first.id)).toMatchObject({ state: 'withdrawn' });
      expect(await (await ask(app, app.token)).json()).toHaveProperty('values');
    } finally {
      await app.close();
    }
  },
);
it.each(['remembered', 'unmarked'] as const)(
  'E10/E26: withdrawal after the %s decision read blocks atomic delivery and expires the retry',
  async (route) => {
    let active = false;
    let batches = 0;
    const reached = deferred();
    const resume = deferred();
    const app = await approvalFixture(async (label) => {
      if (active && label === '/before-batch' && ++batches === 2) {
        active = false;
        reached.resolve();
        await resume.promise;
      }
      return true;
    });
    let inFlight: Promise<Response> | undefined;
    try {
      await setMark(app);
      const id = randomUUID();
      const first = await pending(app, app.token, id);
      if (route === 'remembered') {
        const other = await pending(app, app.token);
        expect((await decide(app, other.id, '1h')).status).toBe(200);
      } else {
        expect((await mark(app, 'work', 'bucket', 'DELETE')).status).toBe(204);
      }
      active = true;
      inFlight = ask(app, app.token, id);
      await reached.promise;
      expect((await withdraw(app, app.token, first.id)).status).toBe(204);
      const before = await requests(app);
      const audit = await auditRows(app);
      resume.resolve();
      const response = await inFlight;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        _tag: 'ServiceUnavailable',
      });
      expect(await requests(app)).toEqual(before);
      expect(await auditRows(app)).toEqual(audit);
      expect(await view(app, first.id)).toMatchObject({ state: 'withdrawn' });
      const retry = await ask(app, app.token, id);
      expect(retry.status).toBe(410);
      expect(await retry.json()).toEqual({
        _tag: 'ApprovalExpired',
        reason: 'withdrawn',
      });
    } finally {
      resume.resolve();
      await inFlight;
      await app.close();
    }
  },
);
it('E26: a mark committed after the covered decision read defeats the guarded delivery', async () => {
  let active = false;
  let batches = 0;
  const reached = deferred();
  const resume = deferred();
  const app = await approvalFixture(async (label) => {
    if (active && label === '/before-batch' && ++batches === 2) {
      active = false;
      reached.resolve();
      await resume.promise;
    }
    return true;
  });
  let inFlight: Promise<Response> | undefined;
  try {
    await setMark(app);
    const id = randomUUID();
    const first = await pending(app, app.token, id);
    await decide(app, first.id);
    active = true;
    inFlight = ask(app, app.token, id);
    await reached.promise;
    await setMark(app, 'work/acme');
    resume.resolve();
    const response = await inFlight;
    expect(response.status).toBe(503);
    expect(await response.json()).toMatchObject({
      _tag: 'ServiceUnavailable',
    });
    expect((await auditRows(app)).some((r) => r.outcome === 'delivered')).toBe(
      false,
    );
    // The once approval still covers the new mark, so the retry delivers.
    const retry = await ask(app, app.token, id);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toHaveProperty('values');
  } finally {
    resume.resolve();
    await inFlight;
    await app.close();
  }
});
it('E5: a limited owner grant cannot read, mark, remove or decide outside its grant', async () => {
  const app = await vaultCheckpoints(async () => true, ['me']);
  try {
    for (const [path, method, payload] of [
      ['/api/ask-first', 'GET'],
      ['/api/ask-first/bucket/work', 'PUT'],
      ['/api/ask-first/bucket/work', 'DELETE'],
      ['/api/approvals', 'GET'],
      ['/api/approvals/missing', 'GET'],
      ['/api/approvals/missing/approve', 'POST', { remember: 'once' }],
      ['/api/approvals/missing/deny', 'POST'],
    ] as const)
      expect((await jsonRequest(app, path, payload, {}, method)).status).toBe(
        403,
      );
  } finally {
    await app.close();
  }
});
it('E5: marks validate paths, remain idempotent and report secret existence', async () => {
  const app = await approvalFixture();
  try {
    expect((await mark(app, 'work//bad')).status).toBe(400);
    expect((await mark(app, 'work/acme/bad name', 'secret')).status).toBe(400);
    await setMark(app, stripe, 'secret');
    await setMark(app, stripe, 'secret');
    expect(await (await fetch(`${app.origin}/api/ask-first`)).json()).toEqual({
      marks: [{ kind: 'secret', path: stripe, exists: true }],
    });
    expect((await mark(app, stripe, 'secret', 'DELETE')).status).toBe(204);
    expect((await mark(app, stripe, 'secret', 'DELETE')).status).toBe(204);
    expect((await fetch(`${app.origin}/api/approvals/missing`)).status).toBe(
      404,
    );
    expect((await decide(app, 'missing')).status).toBe(404);
  } finally {
    await app.close();
  }
});
