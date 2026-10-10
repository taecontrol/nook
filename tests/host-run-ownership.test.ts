import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, readFile, rm } from 'node:fs/promises';
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
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';

const run: ProcessRun = {
  id: 'this-run',
  pid: 54321,
  home: '/tmp/nook-test-run-this-run',
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
  '/tmp/nook-cli-this-run-fixture',
  '/tmp/custom-fixtures/nook-cli-this-run-fixture',
  '/checkout/.local/fixtures/nook-cli-this-run-fixture',
  `${run.home}/fixtures/nook-cli-fixture`,
])(
  'an untagged adopted fixture retains its run provenance at %s',
  async (home) => {
    const own = fixture(12346, { home });
    const signal = await signals([], [own]);
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
    const signal = await signals([parent], [parent, own], {
      ...run,
      parentId: 'parent-run',
    });
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
  { timing: 'preexisting', customRoot: false },
  { timing: 'concurrent', customRoot: true },
])(
  'isolated Linux teardown preserves a $timing foreign fixture and stops an untagged own fixture (custom root: $customRoot)',
  async ({ timing, customRoot }) => {
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
