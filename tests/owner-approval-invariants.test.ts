import { randomUUID } from 'node:crypto';
import { expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { jsonRequest } from './support/authorizations.ts';
import { deferred, listMachines } from './support/machines.ts';
import {
  age,
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
it('E8: an owner denial remains terminal for its attempt after the last mark is removed', async () => {
  const app = await approvalFixture();
  try {
    await setMark(app);
    const id = randomUUID();
    const first = await pending(app, app.token, id);
    await decide(app, first.id, 'deny');
    await mark(app, 'work', 'bucket', 'DELETE');
    expect(await (await ask(app, app.token, id)).json()).toMatchObject({
      _tag: 'ApprovalDenied',
    });
    expect((await auditRows(app)).some((r) => r.outcome === 'delivered')).toBe(
      false,
    );
  } finally {
    await app.close();
  }
});
it.each(['once', 'deny'] as const)(
  'E22: overlapping approve and deny preserve the first committed %s',
  async (choice) => {
    let active = false;
    const reached = deferred();
    const resume = deferred();
    const app = await approvalFixture(async (label) => {
      if (active && label === '/after-batch') {
        active = false;
        reached.resolve();
        await resume.promise;
      }
      return true;
    });
    let inFlight: Promise<Response> | undefined;
    try {
      await setMark(app);
      const first = await pending(app, app.token);
      active = true;
      inFlight = decide(app, first.id, choice);
      await reached.promise;
      const second = await decide(
        app,
        first.id,
        choice === 'once' ? 'deny' : 'once',
      );
      expect(second.status).toBe(409);
      expect(await second.json()).toMatchObject({
        status: choice === 'once' ? 'approved' : 'denied',
        remember: choice === 'once' ? 'once' : null,
      });
      resume.resolve();
      expect((await inFlight).status).toBe(200);
    } finally {
      resume.resolve();
      await inFlight;
      await app.close();
    }
  },
);
it.each(['once', 'deny', 'withdraw-approve', 'withdraw-deny'] as const)(
  'E24: overlapping decision and withdrawal preserve the first committed %s',
  async (choice) => {
    let active = false;
    const reached = deferred();
    const resume = deferred();
    const app = await approvalFixture(async (label) => {
      if (active && label === '/after-batch') {
        active = false;
        reached.resolve();
        await resume.promise;
      }
      return true;
    });
    let inFlight: Promise<Response> | undefined;
    try {
      await setMark(app);
      const first = await pending(app, app.token);
      active = true;
      const withdrawal = choice.startsWith('withdraw');
      inFlight = withdrawal
        ? withdraw(app, app.token, first.id)
        : decide(app, first.id, choice === 'once' ? 'once' : 'deny');
      await reached.promise;
      const second = withdrawal
        ? await decide(
            app,
            first.id,
            choice === 'withdraw-approve' ? 'once' : 'deny',
          )
        : await withdraw(app, app.token, first.id);
      expect(second.status).toBe(withdrawal ? 409 : 204);
      resume.resolve();
      await inFlight;
      expect(await view(app, first.id)).toMatchObject({
        state: withdrawal
          ? 'withdrawn'
          : choice === 'once'
            ? 'approved'
            : 'denied',
      });
    } finally {
      resume.resolve();
      await inFlight;
      await app.close();
    }
  },
);
it.each(['mark', 'grant'])(
  'E26: a %s committed after the covered decision read defeats the guarded delivery',
  async (change) => {
    let active = false;
    let batches = 0;
    const reached = deferred();
    const resume = deferred();
    const app = await approvalFixture(async (label) => {
      if (active && label === '/before-batch' && ++batches === 3) {
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
      if (change === 'mark') await setMark(app, 'work/acme');
      else {
        const [machine] = await listMachines(app);
        await jsonRequest(
          app,
          `/api/machines/${machine.id}/grant`,
          { grant: ['me'], previous: 'all' },
          {},
          'PUT',
        );
      }
      resume.resolve();
      const response = await inFlight;
      expect(response.status).toBe(503);
      expect(await response.json()).toMatchObject({
        _tag: 'ServiceUnavailable',
      });
      expect(
        (await auditRows(app)).some((r) => r.outcome === 'delivered'),
      ).toBe(false);
      expect((await ask(app, app.token, id)).status).toBe(
        change === 'grant' ? 403 : 200,
      );
    } finally {
      resume.resolve();
      await inFlight;
      await app.close();
    }
  },
);
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
it('E9/E23: expiry is not a stored state and late denials are rejected too', async () => {
  const app = await approvalFixture();
  try {
    await setMark(app);
    const first = await pending(app, app.token);
    await age(app, first.id, 'expires_at', 600_001);
    expect((await decide(app, first.id, 'deny')).status).toBe(410);
    expect((await requests(app))[0].status).toBe('pending');
  } finally {
    await app.close();
  }
});
