import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import os, { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startHostIsolation } from '../scripts/lib/host-isolation.ts';
import {
  type HostProcess,
  killOrphans,
  orphanedProcesses,
  type ProcessRun,
  readHostProcess,
  snapshotProcesses,
} from '../scripts/lib/host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
} from '../scripts/lib/host-resources.ts';
import { readLinuxFixtureHomes } from '../scripts/lib/linux-fixture-homes.ts';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';

const run: ProcessRun = {
  id: 'this-run',
  pid: 54321,
  home: '/tmp/nook-test-run-this-run',
  homes: [
    '/tmp/nook-cli-this-run',
    '/tmp/nook-cli-this-run-fixture',
    '/tmp/nook-cli-this-run-old',
  ],
};

function fixture(pid: number, changes: Partial<HostProcess> = {}): HostProcess {
  return {
    pid,
    parent: 1,
    started: `synthetic-generation-${pid}`,
    name: 'node',
    home: '/tmp/unrelated-home',
    run: '',
    ...changes,
  };
}

async function signals(
  before: HostProcess[],
  after: HostProcess[],
  identity = run,
) {
  const signal = vi.fn(() => true as const);
  await killOrphans(
    orphanedProcesses(before, after, identity, 'linux'),
    async (pid) => after.find((item) => item.pid === pid),
    signal,
  );
  return signal;
}

it.each(['preexisting', 'concurrent'])(
  '#32: Linux cleanup preserves a %s fixture owned by another run',
  async (timing) => {
    const other = fixture(12345, {
      home: '/tmp/nook-cli-other-run',
      run: 'other-run',
    });
    const own = fixture(12346, {
      home: '/tmp/nook-cli-this-run',
      run: 'this-run',
    });
    const signal = await signals(timing === 'preexisting' ? [other] : [], [
      other,
      own,
    ]);
    expect(signal).not.toHaveBeenCalledWith(other.pid, 'SIGKILL');
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(own.pid, 'SIGKILL');
  },
);

it.each([
  '/tmp/nook-cli-aB12cD',
  '/tmp/custom-fixtures/nook-cli-aB12cD',
  '/checkout/.local/fixtures/nook-cli-aB12cD',
  `${run.home}/fixtures/nook-cli-aB12cD`,
])(
  'an untagged adopted fixture retains its run provenance at %s',
  async (home) => {
    const own = fixture(12346, { home });
    const signal = await signals([], [own], { ...run, homes: [home] });
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(own.pid, 'SIGKILL');
  },
);

it.each(['preexisting', 'concurrent'])(
  'an untagged %s foreign fixture is not owned by a shared HOME prefix',
  async (timing) => {
    const other = fixture(12345, { home: '/tmp/nook-cli-foreign-fixture' });
    const own = fixture(12346, {
      home: '/tmp/nook-cli-this-run-fixture',
    });
    const signal = await signals(timing === 'preexisting' ? [other] : [], [
      other,
      own,
    ]);
    expect(signal).not.toHaveBeenCalledWith(other.pid, 'SIGKILL');
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(own.pid, 'SIGKILL');
  },
);

it.each([
  { home: '/tmp/nook-cli-this-run-fixture' },
  { home: `${run.home}/fixtures/nook-cli-fixture` },
  { name: 'dbus-daemon', parent: run.pid },
  { name: 'gnome-keyring-d', parent: run.pid },
])(
  'a foreign run tag defeats conflicting apparent ownership: %j',
  async (changes) => {
    const other = fixture(12345, { ...changes, run: 'other-run' });
    expect(await signals([], [other])).not.toHaveBeenCalled();
  },
);

it.each([
  { home: '/tmp/nook-cli-this-run-fixture' },
  { home: `${run.home}/fixtures/nook-cli-fixture` },
  { name: 'dbus-daemon', run: run.id, parent: run.pid },
])(
  'a baseline generation remains protected despite apparent ownership: %j',
  async (changes) => {
    const existing = fixture(12345, changes);
    expect(await signals([existing], [existing])).not.toHaveBeenCalled();
  },
);

it.each(['parent-run', ''])(
  'nested cleanup preserves a live parent fixture with run tag %j',
  async (tag) => {
    const parent = fixture(12345, {
      home: '/tmp/nook-cli-parent-run-fixture',
      parent: run.pid,
      run: tag,
    });
    const own = fixture(12346, {
      home: '/tmp/nook-cli-this-run-fixture',
    });
    const signal = await signals([parent], [parent, own]);
    expect(signal).not.toHaveBeenCalledWith(parent.pid, 'SIGKILL');
    expect(signal).toHaveBeenCalledTimes(1);
    expect(signal).toHaveBeenCalledWith(own.pid, 'SIGKILL');
  },
);

it('normal workers whose HOME equals the run HOME are not leaked fixtures', async () => {
  const worker = fixture(12345, {
    parent: run.pid,
    home: run.home,
    run: run.id,
  });
  expect(await signals([], [worker])).not.toHaveBeenCalled();
});

it('run-owned descendants and adopted daemons remain cleanable without a shared fixture prefix', async () => {
  const child = fixture(12344, { parent: run.pid });
  const descendant = fixture(12345, {
    parent: child.pid,
    name: 'dbus-daemon',
  });
  const adopted = fixture(12346, {
    name: 'gnome-keyring-d',
    run: run.id,
  });
  const unrelated = fixture(12347, { name: 'dbus-daemon' });
  const cycle = fixture(12348, { name: 'dbus-daemon', parent: 12348 });
  const root = fixture(run.pid, { home: `${run.home}/fixtures/root` });
  const signal = await signals(
    [],
    [root, child, descendant, adopted, unrelated, cycle],
  );
  expect(signal.mock.calls).toEqual([
    [descendant.pid, 'SIGKILL'],
    [adopted.pid, 'SIGKILL'],
  ]);
});

it('a reused PID is selected by its new ownership, never its old fixture identity', async () => {
  const old = fixture(12345, { home: '/tmp/nook-cli-this-run-old' });
  const foreign = { ...old, started: 'foreign-generation', run: 'other-run' };
  expect(await signals([old], [foreign])).not.toHaveBeenCalled();
  const own = { ...old, started: 'new-owned-generation' };
  expect((await signals([old], [own])).mock.calls).toEqual([
    [own.pid, 'SIGKILL'],
  ]);
});

it('a run HOME or fixture-name lookalike does not establish ownership', async () => {
  const homeLookalike = fixture(12345, {
    home: `${run.home}-other/fixture`,
  });
  const nameLookalike = fixture(12346, {
    home: '/tmp/nook-cli-other-this-run-fixture',
  });
  expect(
    await signals([], [homeLookalike, nameLookalike]),
  ).not.toHaveBeenCalled();
});

it.runIf(process.platform === 'linux')(
  'a missing run identity refuses CLI fixture creation',
  async () => {
    const root = await mkdtemp('/tmp/nook-fixture-');
    const previous = process.env.NOOK_TEST_RUN;
    delete process.env.NOOK_TEST_RUN;
    try {
      await expect(
        privateKeyring('absent', { tempRoot: root }).then(async (created) => {
          await created.close();
          return 'fixture-created';
        }),
      ).rejects.toThrow(
        'Linux CLI fixtures require an isolated test run identity.',
      );
      expect(await readdir(root)).toEqual([]);
    } finally {
      if (previous !== undefined) process.env.NOOK_TEST_RUN = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux').each(['missing', 'unwritable'])(
  'a %s HOME registry refuses fixture launch and leaves no fixture HOME',
  async (failure) => {
    const root = await mkdtemp('/tmp/nook-registration-');
    const previous = process.env.NOOK_TEST_FIXTURE_HOMES;
    try {
      if (failure === 'missing') delete process.env.NOOK_TEST_FIXTURE_HOMES;
      else {
        const file = resolve(root, 'not-a-registry');
        await writeFile(file, '', { mode: 0o600 });
        process.env.NOOK_TEST_FIXTURE_HOMES = file;
      }
      const before = await readdir(root);
      await expect(
        privateKeyring('absent', { tempRoot: root }).then(async (created) => {
          await created.close();
          return 'fixture-created';
        }),
      ).rejects.toThrow(
        failure === 'missing'
          ? 'Linux CLI fixtures require an isolated HOME registry.'
          : 'Linux CLI fixture HOME could not be registered.',
      );
      expect(await readdir(root)).toEqual(before);
    } finally {
      if (previous === undefined) delete process.env.NOOK_TEST_FIXTURE_HOMES;
      else process.env.NOOK_TEST_FIXTURE_HOMES = previous;
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('a private HOME registry authorizes only records of its own run', async () => {
  const directory = await mkdtemp('/tmp/nook-registry-');
  try {
    await writeFile(
      resolve(directory, 'owned.json'),
      JSON.stringify({ run: run.id, home: '/tmp/nook-cli-owned-fixture' }),
    );
    await writeFile(
      resolve(directory, 'foreign.json'),
      JSON.stringify({
        run: 'other-run',
        home: '/tmp/nook-cli-foreign-fixture',
      }),
    );
    const homes = await readLinuxFixtureHomes(directory, run.id);
    expect(homes).toEqual(['/tmp/nook-cli-owned-fixture']);
    const own = fixture(12346, { home: homes[0] });
    const foreign = fixture(12345, { home: '/tmp/nook-cli-foreign-fixture' });
    expect(
      (await signals([], [foreign, own], { ...run, homes })).mock.calls,
    ).toEqual([[own.pid, 'SIGKILL']]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

it.each([
  null,
  'not-a-record',
  { home: '/tmp/nook-cli-fixture' },
  { run: '', home: '/tmp/nook-cli-fixture' },
  { run: run.id },
  { run: run.id, home: 'nook-cli-fixture' },
  { run: run.id, home: '/tmp/../tmp/nook-cli-fixture' },
  { run: run.id, home: '/tmp/unrelated-home' },
])(
  'an invalid HOME record cannot establish cleanup ownership: %j',
  async (record) => {
    const directory = await mkdtemp('/tmp/nook-registry-');
    try {
      await writeFile(
        resolve(directory, 'invalid.json'),
        JSON.stringify(record),
      );
      await expect(readLinuxFixtureHomes(directory, run.id)).rejects.toThrow(
        'Host isolation found an invalid Linux fixture HOME registry.',
      );
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it('an owner HOME with a fixture-shaped basename cannot authorize cleanup', async () => {
  const directory = await mkdtemp('/tmp/nook-registry-');
  const fakeOwnerHome = '/tmp/nook-cli-owner';
  const owner = vi.spyOn(os, 'userInfo').mockReturnValue({
    ...userInfo(),
    homedir: fakeOwnerHome,
  });
  syncBuiltinESMExports();
  try {
    await writeFile(
      resolve(directory, 'owner.json'),
      JSON.stringify({ run: run.id, home: fakeOwnerHome }),
    );
    await expect(readLinuxFixtureHomes(directory, run.id)).rejects.toThrow(
      'Host isolation found an invalid Linux fixture HOME registry.',
    );
  } finally {
    owner.mockRestore();
    syncBuiltinESMExports();
    await rm(directory, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'linux').each(['malformed', 'nonregular'])(
  'a %s HOME record fails teardown before it signals fixture processes',
  async (failure) => {
    const home = await temporaryTestHome('/tmp/nook-registry-');
    let created: PrivateKeyring | undefined;
    const isolation = await startHostIsolation({
      directories: [resolve(home, 'synthetic-owner/keyrings')],
    });
    let closed = false;
    try {
      created = await privateKeyring('absent');
      const fixtureHome = created.home;
      const processes = (await snapshotProcesses()).filter(
        (item) => item.home === fixtureHome,
      );
      expect(processes.length).toBeGreaterThan(0);
      const record = resolve(isolation.home, 'fixture-homes/invalid.json');
      if (failure === 'malformed') await writeFile(record, '{');
      else {
        const target = resolve(home, 'valid-outside-record.json');
        await writeFile(
          target,
          JSON.stringify({
            run: isolation.env.NOOK_TEST_RUN,
            home: fixtureHome,
          }),
        );
        await symlink(target, record);
      }
      try {
        await expect(isolation.close()).rejects.toThrow(
          'Host isolation found an invalid Linux fixture HOME registry.',
        );
      } finally {
        closed = true;
      }
      for (const item of processes)
        expect(await readHostProcess(item.pid)).toMatchObject({
          started: item.started,
          home: item.home,
        });
      expect(
        await created.command(process.execPath, [
          '-e',
          "process.stdout.write('registry-rejection-preserved-fixture')",
        ]).done,
      ).toMatchObject({
        status: 0,
        stdout: 'registry-rejection-preserved-fixture',
      });
    } finally {
      if (!closed) await isolation.close().catch(() => {});
      await created?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'linux')(
  'a deep temporary root retains the previously supported HOME-private bus',
  async () => {
    const parent = await mkdtemp('/tmp/nook-deep-');
    const root = resolve(
      parent,
      'x'.repeat(60 - Buffer.byteLength(parent) - 1),
    );
    let created: PrivateKeyring | undefined;
    try {
      await mkdir(root);
      expect(Buffer.byteLength(root)).toBe(60);
      expect(
        Buffer.byteLength(resolve(root, 'nook-cli-XXXXXX/bus')),
      ).toBeLessThan(108);
      created = await privateKeyring('absent', { tempRoot: root });
      expect(created.home.startsWith(`${root}/`)).toBe(true);
      expect(decodeURIComponent(created.bus)).toContain(
        resolve(created.home, 'bus'),
      );
      expect(
        await created.command(process.execPath, [
          '-e',
          "process.stdout.write('deep-fixture-ready')",
        ]).done,
      ).toMatchObject({ status: 0, stdout: 'deep-fixture-ready' });
      await created.close();
      expect(await readdir(root)).toEqual([]);
    } finally {
      await created?.close();
      await rm(parent, { recursive: true, force: true });
    }
  },
);

async function foreignFixture() {
  const previous = process.env.NOOK_TEST_RUN;
  process.env.NOOK_TEST_RUN = crypto.randomUUID();
  try {
    return await privateKeyring('absent');
  } finally {
    if (previous === undefined) delete process.env.NOOK_TEST_RUN;
    else process.env.NOOK_TEST_RUN = previous;
  }
}

async function adoptedFixture(home: string) {
  const marker = resolve(home, 'adopted-pid');
  const launcher = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
  env: process.env, detached: true, stdio: 'ignore'
});
if (!child.pid) throw new Error('Synthetic fixture did not start.');
writeFileSync(${JSON.stringify(marker)}, String(child.pid));
child.unref();`,
    ],
    {
      env: testEnvironment(home, { NOOK_TEST_RUN: undefined }),
      stdio: 'ignore',
    },
  );
  const [status] = await once(launcher, 'close');
  expect(status).toBe(0);
  const pid = Number(await readFile(marker, 'utf8'));
  let observed: HostProcess | undefined;
  await expect
    .poll(async () => {
      observed = await readHostProcess(pid);
      return observed?.parent;
    })
    .toBe(1);
  if (!observed) throw new Error('Synthetic adopted fixture is missing.');
  expect(observed.run).toBe('');
  expect(observed.home).toBe(home);
  return observed;
}

async function stopKnownFixture(identity: HostProcess | undefined) {
  if (!identity) return;
  const current = await readHostProcess(identity.pid);
  if (current?.started !== identity.started) return;
  try {
    process.kill(identity.pid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

it.runIf(process.platform === 'linux').each([
  { timing: 'preexisting', customRoot: false, closeOwn: false },
  { timing: 'concurrent', customRoot: true, closeOwn: true },
])(
  'isolated Linux teardown preserves a $timing foreign fixture and stops an untagged own fixture (custom root: $customRoot, own closed: $closeOwn)',
  async ({ timing, customRoot, closeOwn }) => {
    const home = await temporaryTestHome('/tmp/nook-own-');
    const resources = {
      directories: [resolve(home, 'synthetic-owner/keyrings')],
    };
    const before = await fingerprintHost(resources);
    let foreign: PrivateKeyring | undefined;
    let own: PrivateKeyring | undefined;
    let adopted: HostProcess | undefined;
    let isolation: Awaited<ReturnType<typeof startHostIsolation>> | undefined;
    let closed = false;
    try {
      if (timing === 'preexisting') foreign = await foreignFixture();
      isolation = await startHostIsolation(resources);
      const root = resolve(home, 'external-fixtures');
      if (customRoot) await mkdir(root);
      own = await privateKeyring(
        'absent',
        customRoot ? { tempRoot: root } : {},
      );
      adopted = await adoptedFixture(own.home);
      if (timing === 'concurrent') foreign = await foreignFixture();
      if (!foreign) throw new Error('Foreign fixture did not start.');
      const foreignHome = foreign.home;
      const foreignProcesses = (await snapshotProcesses()).filter(
        (item) => item.home === foreignHome,
      );
      expect(foreignProcesses.length).toBeGreaterThan(0);
      if (closeOwn) {
        await own.close();
        expect(await readHostProcess(adopted.pid)).toMatchObject({
          started: adopted.started,
          home: adopted.home,
        });
      }
      try {
        await expect(isolation.close()).rejects.toThrow(
          'orphaned test process PID',
        );
      } finally {
        closed = true;
      }
      for (const item of foreignProcesses)
        expect(await readHostProcess(item.pid)).toMatchObject({
          started: item.started,
          home: item.home,
        });
      expect(
        await foreign.command(process.execPath, [
          '-e',
          "process.stdout.write('survived')",
        ]).done,
      ).toMatchObject({
        status: 0,
        stdout: 'survived',
      });
      const identity = adopted;
      await expect
        .poll(async () => {
          const current = await readHostProcess(identity.pid);
          return (
            current?.started === identity.started &&
            current.home === identity.home
          );
        })
        .toBe(false);
      assertHostUnchanged(before, await fingerprintHost(resources));
    } finally {
      if (isolation && !closed) await isolation.close().catch(() => {});
      await stopKnownFixture(adopted);
      await own?.close();
      await foreign?.close();
      await rm(home, { recursive: true, force: true });
    }
  },
  20_000,
);
