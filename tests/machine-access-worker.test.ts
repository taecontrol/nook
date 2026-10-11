import { createInterface } from 'node:readline';
import type { Machine } from '@nook/contract';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import { ownerRuntime } from './support/authorizations.ts';
import { checkpointRuntime } from './support/checkpoint-runtime.ts';
import { issueGrant, seedGrantTree } from './support/grants.ts';
import { saveAccess } from './support/machine-access.ts';
import {
  expectPrivate,
  listMachines,
  revokeMachine,
  tokenHash,
  tokenSnapshot,
} from './support/machines.ts';
import { runtime, type TestRuntime } from './support/runtime.ts';

let app: TestRuntime;
beforeEach(async () => {
  app = await ownerRuntime(await runtime());
  await seedGrantTree(app, ['me', 'work', 'work/acme', 'work/beta']);
  return () => app.close();
});
async function approved(grant: 'all' | string[] = ['work/acme']) {
  const issued = await issueGrant(app, grant);
  return { ...issued, machine: (await listMachines(app))[0] };
}
async function expectUnchanged(before: string) {
  expect(
    (await tokenSnapshot(app)) === before,
    'A rejected save preserves every private row',
  ).toBe(true);
}

it('E1: editing one opaque id preserves credentials, dates, and a duplicate-name approval', async () => {
  const { machine } = await approved();
  await issueGrant(app, ['work/acme']);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('UPDATE machine_tokens SET last_used_at=1234567890').run();
  const machines = await listMachines(app);
  const before = JSON.stringify(
    (
      await db
        .prepare(
          'SELECT id, token_hash, machine_name, created_at, last_used_at FROM machine_tokens ORDER BY id',
        )
        .all()
    ).results,
  );
  const response = await saveAccess(
    app,
    machine.id,
    ['work/acme', 'work/beta'],
    ['work/acme'],
  );
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    ...machines.find((entry) => entry.id === machine.id),
    grant: ['work/acme', 'work/beta'],
  });
  const after = JSON.stringify(
    (
      await db
        .prepare(
          'SELECT id, token_hash, machine_name, created_at, last_used_at FROM machine_tokens ORDER BY id',
        )
        .all()
    ).results,
  );
  expect(
    after === before,
    'A grant edit changes no identity or credential',
  ).toBe(true);
  expect(
    (await listMachines(app)).find((entry) => entry.id !== machine.id)?.grant,
  ).toEqual(['work/acme']);
});

it('E3: all and limited grants switch in both directions, normalizing new and previous roots', async () => {
  const { machine } = await approved('all');
  const limited = await saveAccess(
    app,
    machine.id,
    ['work/acme', 'work', 'work'],
    'all',
  );
  expect(limited.status).toBe(200);
  expect(((await limited.json()) as Machine).grant).toEqual(['work']);
  const db = await app.mf.getD1Database('DB');
  expect(
    await db
      .prepare('SELECT grant_json FROM machine_tokens WHERE id=?')
      .bind(machine.id)
      .first('grant_json'),
  ).toBe('["work"]');
  const all = await saveAccess(app, machine.id, 'all', ['work/acme', 'work']);
  expect(all.status).toBe(200);
  expect(((await all.json()) as Machine).grant).toBe('all');
});

it.each(['never-existed', 'deleted-before-batch'])(
  'E4: a %s bucket rejects the entire save at its atomic boundary',
  async (state) => {
    let armed = false;
    const measured = await ownerRuntime(
      await checkpointRuntime(async (label) => {
        if (armed && label === '/machine-before-batch') {
          armed = false;
          await (await measured.mf.getD1Database('DB'))
            .prepare("DELETE FROM buckets WHERE path='work/beta'")
            .run();
        }
      }),
    );
    try {
      await seedGrantTree(measured, ['me', 'work', 'work/acme', 'work/beta']);
      await issueGrant(measured, ['work/acme']);
      const [machine] = await listMachines(measured);
      const before = await tokenSnapshot(measured);
      armed = state === 'deleted-before-batch';
      const response = await saveAccess(
        measured,
        machine.id,
        ['work/acme', state === 'never-existed' ? 'work/missing' : 'work/beta'],
        machine.grant,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({
        _tag: 'GrantBucketNotFound',
        message: 'Some selected buckets no longer exist. Choose again.',
      });
      expect((await tokenSnapshot(measured)) === before).toBe(true);
    } finally {
      await measured.close();
    }
  },
);

it.each(
  [[], null, {}, 'work/acme', ['Work'], ['work/acme', 1]].map((grant) => ({
    grant,
  })),
)(
  'E5: invalid new grant %j returns InvalidBucketGrant and changes nothing',
  async ({ grant }) => {
    const { machine } = await approved();
    const before = await tokenSnapshot(app);
    const response = await saveAccess(app, machine.id, grant, machine.grant);
    expect(response.status).toBe(400);
    expect((await response.json())._tag).toBe('InvalidBucketGrant');
    await expectUnchanged(before);
  },
);
it.each([[], null, {}, 'work/acme'].map((previous) => ({ previous })))(
  'E5: invalid previous grant %j cannot become a writing contract',
  async ({ previous }) => {
    const { machine } = await approved();
    const before = await tokenSnapshot(app);
    const response = await saveAccess(app, machine.id, 'all', previous);
    expect(response.status).toBe(400);
    expect((await response.json())._tag).toBe('InvalidBucketGrant');
    await expectUnchanged(before);
  },
);

it('E6: retry after a committed lost response and an unchanged save both succeed without further changes', async () => {
  const { machine } = await approved();
  const next = ['work/acme', 'work/beta'];
  const first = await saveAccess(app, machine.id, next, machine.grant);
  await first.body?.cancel();
  const committed = await tokenSnapshot(app);
  expect((await listMachines(app))[0].grant).toEqual(next);
  for (const previous of [machine.grant, next]) {
    const retry = await saveAccess(app, machine.id, next, previous);
    expect(retry.status).toBe(200);
    expect(((await retry.json()) as Machine).grant).toEqual(next);
    await expectUnchanged(committed);
  }
});

it('E7: a stale writer cannot silently widen a narrowed grant and receives the current grant', async () => {
  const { machine } = await approved('all');
  expect((await saveAccess(app, machine.id, ['work/acme'], 'all')).status).toBe(
    200,
  );
  const before = await tokenSnapshot(app);
  const stale = await saveAccess(app, machine.id, ['work/beta'], 'all');
  expect(stale.status).toBe(409);
  expect(await stale.json()).toEqual({
    _tag: 'MachineAccessChanged',
    current: ['work/acme'],
  });
  await expectUnchanged(before);
  expect((await saveAccess(app, machine.id, ['work/acme'], 'all')).status).toBe(
    200,
  );
  await expectUnchanged(before);
});

it('E8: revoked and unknown machines stay absent, including missing-bucket saves', async () => {
  const { machine } = await approved();
  expect((await revokeMachine(app, machine.id)).status).toBe(204);
  const before = await tokenSnapshot(app);
  for (const id of [machine.id, 'never-existed', "' OR 1=1 --"])
    for (const grant of ['all', ['work/missing']]) {
      expect((await saveAccess(app, id, grant, machine.grant)).status).toBe(
        404,
      );
      await expectUnchanged(before);
    }
  expect((await saveAccess(app, machine.id, [], machine.grant)).status).toBe(
    400,
  );
});

it('E9: only owner Access at the same Origin can edit; a machine Bearer can never edit itself', async () => {
  const { machine, token } = await approved();
  const issuer = await accessFixture();
  await app.setBindings(access, { outboundService: issuer.outboundService });
  const owner = await issuer.assertion();
  const other = await issuer.assertion({ email: 'other@nook.test' });
  const before = await tokenSnapshot(app);
  for (const [headers, status] of [
    [{}, 401],
    [{ Authorization: `Bearer ${token}` }, 401],
    [{ 'Cf-Access-Jwt-Assertion': 'invalid' }, 401],
    [{ 'Cf-Access-Jwt-Assertion': other }, 403],
    [{ 'Cf-Access-Jwt-Assertion': owner, Origin: 'https://foreign.test' }, 403],
  ] as const) {
    expect(
      (await saveAccess(app, machine.id, 'all', machine.grant, headers)).status,
    ).toBe(status);
    await expectUnchanged(before);
  }
  for (const path of [
    `/api/machine/machines/${machine.id}/grant`,
    `/api/machine/${machine.id}/grant`,
  ]) {
    expect(
      (
        await fetch(app.origin + path, {
          method: 'PUT',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({ grant: 'all', previous: machine.grant }),
        })
      ).status,
    ).toBe(404);
    await expectUnchanged(before);
  }
  expect(
    (
      await saveAccess(app, machine.id, 'all', machine.grant, {
        'Cf-Access-Jwt-Assertion': owner,
        Origin: app.origin,
      })
    ).status,
  ).toBe(200);
});

it('E9: a restricted principal is denied before D1 even when it names the target machine', async () => {
  const labels: string[] = [];
  const restricted = await checkpointRuntime(
    async (label) => {
      labels.push(label);
    },
    { principalGrant: ['work'] },
  );
  try {
    const db = await restricted.mf.getD1Database('DB');
    await db
      .prepare(
        'INSERT INTO machine_tokens(id, token_hash, machine_name, grant_json, created_at) VALUES (?, ?, ?, ?, ?)',
      )
      .bind('target', 'synthetic-private-hash', 'kept', '["work"]', 1)
      .run();
    const before = await tokenSnapshot(restricted);
    expect(
      (await saveAccess(restricted, 'target', 'all', ['work'])).status,
    ).toBe(403);
    expect(labels).toEqual([]);
    expect((await tokenSnapshot(restricted)) === before).toBe(true);
  } finally {
    await restricted.close();
  }
});

class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
it('E10: success, validation, conflicts, and real storage failures never expose a token or hash', async () => {
  const log = new PrivateLog();
  await app.setBindings(
    { LOCAL_OWNER: 'synthetic-owner', LOCAL_ORIGIN: app.origin },
    {
      log,
      handleRuntimeStdio: (stdout, stderr) => {
        for (const input of [stdout, stderr])
          createInterface({ input }).on('line', (line) =>
            log.messages.push(line),
          );
      },
    },
  );
  const { token, machine } = await approved();
  const hash = await tokenHash(app, token);
  for (const [grant, status] of [
    ['all', 200],
    [[], 400],
    [['work/beta'], 409],
  ] as const) {
    const response = await saveAccess(app, machine.id, grant, machine.grant);
    expect(response.status).toBe(status);
    const text = await response.text();
    expectPrivate(text, [token, hash]);
    expect(/token_hash|"token"/.test(text)).toBe(false);
  }
  const db = await app.mf.getD1Database('DB');
  const before = await tokenSnapshot(app);
  await db
    .prepare(
      `CREATE TRIGGER access_failure BEFORE UPDATE ON machine_tokens BEGIN SELECT RAISE(ABORT, '${hash}'); END`,
    )
    .run();
  const failed = await saveAccess(app, machine.id, ['work/beta'], 'all');
  expect(failed.status).toBe(503);
  expect(await failed.json()).toEqual({ _tag: 'ServiceUnavailable' });
  expectPrivate(log.messages.join('\n'), [token, hash]);
  await expectUnchanged(before);
});

it('E17: each save outcome uses exactly one D1 batch and no separate read', async () => {
  const labels: string[] = [];
  const measured = await ownerRuntime(
    await checkpointRuntime(async (label) => {
      labels.push(label);
    }),
  );
  try {
    await seedGrantTree(measured, ['me', 'work', 'work/acme']);
    await issueGrant(measured, ['work/acme']);
    const [machine] = await listMachines(measured);
    for (const [id, grant, previous, status] of [
      [machine.id, 'all', ['work/acme'], 200],
      [machine.id, 'all', ['work/acme'], 200],
      [machine.id, ['work/acme'], ['work/acme'], 409],
      [machine.id, ['work/missing'], 'all', 400],
      ['never-existed', 'all', 'all', 404],
    ] as const) {
      labels.length = 0;
      expect((await saveAccess(measured, id, grant, previous)).status).toBe(
        status,
      );
      expect(labels).toEqual([
        '/machine-before-batch',
        '/machine-batch',
        '/machine-write',
      ]);
    }
  } finally {
    await measured.close();
  }
});
