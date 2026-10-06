import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  realpath,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import {
  killOrphans,
  orphanedProcesses,
  readHostProcess,
  snapshotProcesses,
  unverifiedMacProcesses,
} from '../scripts/lib/host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
  ownerResources,
} from '../scripts/lib/host-resources.ts';
import { observeKeychains } from '../scripts/lib/macos-keychains.ts';
import {
  type MacProcessGroup,
  readMacProcessGroups,
  recordMacProcessGroup,
} from '../scripts/lib/macos-process-groups.ts';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import {
  closeMacFixtureProcess,
  readMacFixtureProcess,
  runMacHostLifecycle,
} from './support/macos-host-lifecycle.ts';

it('E18: macOS owner resources include the real Keychains, config, and HOME-scoped lock directories', () => {
  const owner = {
    homedir: '/tmp/synthetic-owner',
    uid: 123,
    gid: 123,
    username: 'synthetic',
    shell: '/bin/sh',
  };
  const resources = ownerResources(
    { HOME: '/tmp/forged-home' },
    owner,
    'darwin',
  );
  expect(resources.directories).toEqual([
    '/tmp/synthetic-owner/Library/Keychains',
    '/tmp/synthetic-owner/.config/nook',
    '/tmp/synthetic-owner/Library/Application Support/nook',
  ]);
  expect(resources.keychainHome).toBe(owner.homedir);
});

it('E18: search-list and default-keychain changes fail through an injected read-only observer', async () => {
  const home = await temporaryTestHome();
  const resources = { directories: [], keychainHome: home };
  const initial = {
    searchList: '"/synthetic/login.keychain-db"',
    defaultKeychain: '"/synthetic/login.keychain-db"',
    loginKeychain: '"/synthetic/login.keychain-db"',
  };
  let state = { ...initial };
  const observer = vi.fn(async (_home: string) => state);
  try {
    const before = await fingerprintHost(resources, observer);
    assertHostUnchanged(before, await fingerprintHost(resources, observer));
    for (const field of [
      'searchList',
      'defaultKeychain',
      'loginKeychain',
    ] as const) {
      state = { ...initial, [field]: '"/synthetic/changed.keychain-db"' };
      const after = await fingerprintHost(resources, observer);
      expect(() => assertHostUnchanged(before, after)).toThrow(/keychain/i);
    }
    expect(
      observer.mock.calls.every(([observedHome]) => observedHome === home),
    ).toBe(true);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('E18: keychain name/kind changes fail, metadata refreshes pass, and config/lock writes fail', async () => {
  const home = await temporaryTestHome();
  const keychains = resolve(home, 'Library/Keychains');
  const config = resolve(home, '.config/nook');
  const locks = resolve(home, 'Library/Application Support/nook');
  const item = resolve(keychains, 'synthetic.keychain-db');
  const resources = { directories: [keychains, config, locks] };
  try {
    for (const directory of resources.directories)
      await mkdir(directory, { recursive: true });
    await writeFile(item, 'synthetic');
    const before = await fingerprintHost(resources);
    await writeFile(item, 'synthetic metadata refresh with another size');
    await utimes(item, new Date(4000), new Date(4000));
    assertHostUnchanged(before, await fingerprintHost(resources));
    await rename(item, resolve(keychains, 'renamed.keychain-db'));
    const changedNames = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, changedNames)).toThrow(/changed/);
    await rename(resolve(keychains, 'renamed.keychain-db'), item);
    await rm(item);
    await mkdir(item);
    const changedKind = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, changedKind)).toThrow(
      /kind changed/,
    );
    for (const directory of [config, locks]) {
      const baseline = await fingerprintHost(resources);
      await writeFile(resolve(directory, 'synthetic-item'), 'synthetic');
      const changed = await fingerprintHost(resources);
      expect(() => assertHostUnchanged(baseline, changed)).toThrow(
        /Nook.*directory changed/,
      );
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('E18: replacing an existing keychain file with a symlink fails without following it', async () => {
  const home = await temporaryTestHome();
  const directory = resolve(home, 'Library/Keychains');
  const entry = resolve(directory, 'synthetic.keychain-db');
  try {
    await mkdir(directory, { recursive: true });
    await writeFile(entry, 'synthetic');
    const before = await fingerprintHost({ directories: [directory] });
    await rm(entry);
    const destination = resolve(home, 'outside-keychains');
    await mkdir(destination);
    await writeFile(resolve(destination, 'must-not-be-followed'), 'synthetic');
    await symlink(destination, entry);
    const after = await fingerprintHost({ directories: [directory] });
    expect(() => assertHostUnchanged(before, after)).toThrow('kind changed');
    expect(after.directories[directory]).toEqual([
      expect.objectContaining({ name: '.', kind: 'directory' }),
      expect.objectContaining({
        name: './synthetic.keychain-db',
        kind: 'symlink',
      }),
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

describe.runIf(process.platform === 'darwin')(
  'macOS process observation without /proc',
  () => {
    it('E19: Vitest reports and terminates a known fixture child after its worker pool closes', async () => {
      const result = await runMacHostLifecycle('onClose');
      expect(result.knownChild).toBeDefined();
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `orphaned test process PID ${result.knownChild?.pid} terminated`,
      );
      expect(result.output).toContain('Host isolation failed');
      expect(result.childAlive).toBe(false);
      expect(result.remaining).toBe(0);
    }, 60_000);

    it('E19: Vitest reports an ambiguous group without signalling its unmatched generation', async () => {
      const result = await runMacHostLifecycle('ambiguousClose');
      expect(result.knownChild).toBeDefined();
      expect(result.status).toBe(1);
      expect(result.output).toContain(
        `no surviving recorded identity; no signal was sent to PID ${result.knownChild?.pid}`,
      );
      expect(result.output).toContain('Host isolation failed');
      expect(result.childAlive).toBe(true);
      expect(result.remaining).toBe(1);
    }, 60_000);

    it.each(['buildProduct', 'buildTest'] as const)(
      'E19: %s releases its compiler subprocess before closing host isolation',
      async (mode) => {
        const result = await runMacHostLifecycle(mode);
        expect(result.status).toBe(0);
        expect(result.remaining).toBe(0);
        expect(result.output).not.toContain('Host isolation failed');
      },
      60_000,
    );

    it('E19: ps exposes kernel group/uid metadata and a recorded fixture group is killed and reported', async () => {
      const home = await realpath(
        await temporaryTestHome('/tmp/nook-cli-orphan-'),
      );
      const directory = resolve(home, 'process-groups');
      await mkdir(directory, { mode: 0o700 });
      const before = await snapshotProcesses();
      const child = spawn(
        process.execPath,
        ['-e', 'setInterval(() => {}, 1000)'],
        {
          env: testEnvironment(home),
          detached: true,
          stdio: 'ignore',
        },
      );
      const closed = once(child, 'exit');
      if (!child.pid) throw new Error('Synthetic child did not start.');
      const pid = child.pid;
      try {
        recordMacProcessGroup(pid, undefined, directory);
        const info = await readHostProcess(pid);
        expect(info?.group).toBe(pid);
        expect(info?.uid).toBe(userInfo().uid);
        expect(info?.started).toMatch(
          /^\w{3}\s+\w{3}\s+\d+\s+\d{2}:\d{2}:\d{2}\s+\d{4}$/,
        );
        expect((await readHostProcess(pid))?.started).toBe(info?.started);
        expect(info?.home).toBe('');
        expect(info?.run).toBe('');
        const records = await readMacProcessGroups(directory);
        expect(
          records.some(
            (record) =>
              record.group === pid &&
              record.root === Number(process.env.NOOK_TEST_ROOT_PID),
          ),
        ).toBe(true);
        const orphans = orphanedProcesses(before, await snapshotProcesses(), {
          id: 'synthetic-run',
          pid: Number(process.env.NOOK_TEST_ROOT_PID),
          home,
          groups: records,
        });
        expect(orphans.some((item) => item.pid === pid)).toBe(true);
        const messages = await killOrphans(
          orphans.filter((item) => item.pid === pid),
        );
        expect(() =>
          assertHostUnchanged(
            { directories: {} },
            { directories: {} },
            messages,
          ),
        ).toThrow(`orphaned test process PID ${pid} terminated`);
        await closed;
        expect(await readHostProcess(pid)).toBeUndefined();
      } finally {
        child.kill('SIGKILL');
        await rm(home, { recursive: true, force: true });
      }
    });

    it('E19: a reparented fixture child remains identifiable by its recorded process group', async () => {
      const home = await realpath(
        await temporaryTestHome('/tmp/nook-cli-adopted-'),
      );
      const directory = resolve(home, 'process-groups');
      await mkdir(directory, { mode: 0o700 });
      const before = await snapshotProcesses();
      const launcher = spawn(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { spawn } from 'node:child_process';
        import { recordMacProcessGroup } from ${JSON.stringify(pathToFileURL(resolve('scripts/lib/macos-process-groups.ts')).href)};
        const child = spawn(process.execPath,
          ['-e', 'setInterval(() => {}, 1000)'], { env: process.env, stdio: 'ignore' });
        recordMacProcessGroup(child.pid, undefined, ${JSON.stringify(directory)});
        child.unref(); process.stdout.write(String(child.pid));
      `,
        ],
        {
          env: testEnvironment(home),
          detached: true,
          stdio: ['ignore', 'pipe', 'ignore'],
        },
      );
      if (!launcher.pid) throw new Error('Synthetic launcher did not start.');
      recordMacProcessGroup(launcher.pid, undefined, directory);
      let output = '';
      launcher.stdout.on('data', (chunk) => {
        output += chunk;
      });
      const group = launcher.pid;
      let pid: number | undefined;
      let owned: ReturnType<typeof readMacFixtureProcess>;
      try {
        await once(launcher, 'close');
        pid = Number(output);
        owned = readMacFixtureProcess(pid);
        expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
        await expect
          .poll(async () => (await readHostProcess(pid!))?.parent)
          .toBe(1);
        const info = await readHostProcess(pid);
        expect(info?.group).toBe(group);
        const records = await readMacProcessGroups(directory);
        expect(
          records.some(
            (record) =>
              record.pid === pid &&
              record.group === group &&
              record.started === info?.started,
          ),
        ).toBe(true);
        const orphans = orphanedProcesses(before, await snapshotProcesses(), {
          id: 'synthetic-run',
          pid: Number(process.env.NOOK_TEST_ROOT_PID),
          home,
          groups: records,
        });
        expect(orphans.some((item) => item.pid === pid)).toBe(true);
        const messages = await killOrphans(
          orphans.filter((item) => item.pid === pid),
        );
        expect(messages).toEqual([
          `orphaned test process PID ${pid} terminated`,
        ]);
        await expect.poll(() => readHostProcess(pid!)).toBeUndefined();
      } finally {
        await closeMacFixtureProcess(owned);
        launcher.kill('SIGKILL');
        await rm(home, { recursive: true, force: true });
      }
    });

    it('E18: the real read-only observer distinguishes an empty search list from absent login/default keychains', async () => {
      const home = await realpath(await temporaryTestHome());
      try {
        expect(await observeKeychains(home)).toEqual({
          searchList: '',
          defaultKeychain: '<absent>',
          loginKeychain: '<absent>',
        });
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    });

    it('E19: HOME-like argv and an embedded environment assignment cannot classify or kill an unrelated process', async () => {
      const home = await realpath(
        await temporaryTestHome('/tmp/nook-unrelated-'),
      );
      const env = testEnvironment(home, {
        LC_NOOK_PROBE: 'x HOME=/tmp/nook-cli-single-suffix-impostor',
      });
      delete env.HOME;
      const child = spawn(
        process.execPath,
        [
          '-e',
          'setInterval(() => {}, 1000)',
          'HOME=/tmp/nook-cli-argv-impostor',
        ],
        { env, detached: true, stdio: 'ignore' },
      );
      const closed = once(child, 'exit');
      if (!child.pid) throw new Error('Synthetic child did not start.');
      try {
        const item = await readHostProcess(child.pid);
        expect(item?.home).toBe('');
        expect(item?.run).toBe('');
        const orphans = orphanedProcesses([], item ? [item] : [], {
          id: 'synthetic-run',
          pid: 999999,
          home: '/tmp/another-run',
          groups: [],
        });
        const kill = vi.fn(() => true as const);
        await killOrphans(orphans, async () => item, kill);
        expect(kill).not.toHaveBeenCalled();
        expect(child.exitCode).toBeNull();
      } finally {
        child.kill('SIGKILL');
        await closed;
        await rm(home, { recursive: true, force: true });
      }
    });
  },
);

it('E19: PID identity is rechecked before killing an orphan', async () => {
  const item = {
    pid: 999999,
    parent: 1,
    group: 999999,
    uid: 123,
    started: 'synthetic-start',
    name: 'node',
    home: '/tmp/nook-cli-orphan',
    run: 'synthetic-run',
  };
  const kill = vi.fn(() => true as const);
  for (const current of [
    undefined,
    { ...item, started: 'reused-pid' },
    { ...item, uid: 456 },
    { ...item, group: 123456 },
  ])
    expect(await killOrphans([item], async () => current, kill)).toEqual([]);
  expect(kill).not.toHaveBeenCalled();
  expect(await killOrphans([item], async () => item, kill)).toEqual([
    'orphaned test process PID 999999 terminated',
  ]);
  expect(kill).toHaveBeenCalledWith(item.pid, 'SIGKILL');
});

it('E19: process-group records require valid spawned identities and matching uid', async () => {
  const home = await temporaryTestHome();
  const directory = resolve(home, 'groups');
  await mkdir(directory);
  vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
  vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
  const identity = {
    pid: 999999,
    parent: 1,
    group: 999999,
    uid: userInfo().uid,
    started: 'synthetic-start',
    name: 'node',
    home: '',
    run: '',
  };
  const inspect = () => identity;
  try {
    recordMacProcessGroup(999999, inspect);
    expect(await readMacProcessGroups(directory)).toEqual([
      {
        pid: 999999,
        started: identity.started,
        group: 999999,
        root: process.pid,
        uid: userInfo().uid,
      },
    ]);
    for (const pid of [undefined, 0, -1, 1.5])
      expect(() => recordMacProcessGroup(pid, inspect)).toThrow(
        'isolated process-group registry',
      );
    for (const root of ['', '0', '-1', '1.5', 'invalid']) {
      vi.stubEnv('NOOK_TEST_ROOT_PID', root);
      expect(() => recordMacProcessGroup(999999, inspect)).toThrow(
        'isolated process-group registry',
      );
    }
    vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
    expect(recordMacProcessGroup(999998, () => undefined)).toBeUndefined();
    for (const invalid of [
      { ...identity, pid: 999998 },
      { ...identity, uid: identity.uid + 1 },
      { ...identity, started: '' },
      { ...identity, group: 0 },
      { ...identity, group: -1 },
      { ...identity, group: 1.5 },
    ])
      expect(() => recordMacProcessGroup(999999, () => invalid)).toThrow(
        'invalid kernel identity',
      );
    vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', undefined);
    expect(() => recordMacProcessGroup(999999, inspect)).toThrow(
      'isolated process-group registry',
    );
    const record = {
      pid: identity.pid,
      started: identity.started,
      group: identity.group,
      root: process.pid,
      uid: identity.uid,
    };
    for (const invalid of [
      { ...record, pid: 0 },
      { ...record, pid: 1.5 },
      { ...record, group: 0 },
      { ...record, group: 1.5 },
      { ...record, root: 0 },
      { ...record, root: 1.5 },
      { ...record, uid: identity.uid + 1 },
      { ...record, started: '' },
      { ...record, started: undefined },
    ]) {
      await writeFile(
        resolve(directory, '999999.json'),
        JSON.stringify(invalid),
      );
      await expect(readMacProcessGroups(directory)).rejects.toThrow(
        'invalid macOS process-group record',
      );
    }
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it('E19: macOS classification requires the run identity, matching uid, and absence from baseline', () => {
  const item = {
    pid: 200,
    parent: 1,
    group: 200,
    uid: 123,
    started: 'synthetic-start',
    name: 'node',
    home: '/tmp/nook-cli-forged',
    run: '',
  };
  const run = {
    id: 'synthetic-run',
    pid: 100,
    home: '/tmp/synthetic-home',
    uid: 123,
    groups: [
      {
        pid: item.pid,
        started: item.started,
        group: item.group,
        root: 100,
        uid: item.uid,
      },
    ],
  };
  expect(orphanedProcesses([], [item], run, 'darwin')).toEqual([item]);
  expect(orphanedProcesses([item], [item], run, 'darwin')).toEqual([]);
  expect(orphanedProcesses([], [{ ...item, uid: 456 }], run, 'darwin')).toEqual(
    [],
  );
  expect(
    orphanedProcesses([], [item], { ...run, groups: [] }, 'darwin'),
  ).toEqual([]);
  for (const record of [
    { ...run.groups[0], root: 101 },
    { ...run.groups[0], uid: 456 },
    { ...run.groups[0], started: 'previous-member' },
  ])
    expect(
      orphanedProcesses([], [item], { ...run, groups: [record] }, 'darwin'),
    ).toEqual([]);
  const child = { ...item, group: 300, parent: 100 };
  expect(
    orphanedProcesses([], [child], { ...run, groups: [] }, 'darwin'),
  ).toEqual([child]);
  expect(
    orphanedProcesses(
      [],
      [{ ...child, uid: 456 }],
      { ...run, groups: [] },
      'darwin',
    ),
  ).toEqual([]);
  const grandchild = { ...child, pid: 201, parent: child.pid };
  expect(
    orphanedProcesses(
      [],
      [child, grandchild],
      { ...run, groups: [] },
      'darwin',
    ),
  ).toEqual([child, grandchild]);
  const cycle = [
    { ...child, parent: 201 },
    { ...grandchild, parent: child.pid },
  ];
  expect(
    orphanedProcesses([], cycle, { ...run, groups: [] }, 'darwin'),
  ).toEqual([]);
  const previous = { ...item, started: 'previous-pid-identity' };
  expect(orphanedProcesses([previous], [item], run, 'darwin')).toEqual([item]);
  expect(
    orphanedProcesses(
      [],
      [{ ...item, pid: run.pid, parent: run.pid }],
      run,
      'darwin',
    ),
  ).toEqual([]);
});

it('E19: a recycled process-group number never authorizes killing an unrelated process', async () => {
  const unrelated = {
    pid: 200,
    parent: 1,
    group: 200,
    uid: 123,
    started: 'later-process-identity',
    name: 'node',
    home: '',
    run: '',
  };
  const run = {
    id: 'synthetic-run',
    pid: 100,
    home: '/tmp/synthetic-home',
    uid: 123,
    groups: [
      {
        pid: 200,
        started: 'previous-process-identity',
        group: 200,
        root: 100,
        uid: 123,
      },
    ],
  };
  const orphans = orphanedProcesses([], [unrelated], run, 'darwin');
  const kill = vi.fn(() => true as const);
  await killOrphans(orphans, async () => unrelated, kill);
  expect(orphans).toEqual([]);
  expect(kill).not.toHaveBeenCalled();
  expect(unverifiedMacProcesses([], [unrelated], run)).toEqual([unrelated]);
  expect(
    unverifiedMacProcesses([], [unrelated], { ...run, groups: [] }),
  ).toEqual([]);
  const descendant = { ...unrelated, parent: run.pid };
  expect(unverifiedMacProcesses([], [descendant], run)).toEqual([]);
  expect(orphanedProcesses([], [descendant], run, 'darwin')).toEqual([
    descendant,
  ]);
  expect(() =>
    assertHostUnchanged({ directories: {} }, { directories: {} }, [
      'macOS process group has no surviving recorded identity',
    ]),
  ).toThrow('no surviving recorded identity');
});

it('E19: a surviving registered member proves its inherited group after the leader exits', () => {
  const member = {
    pid: 201,
    parent: 1,
    group: 200,
    uid: 123,
    started: 'member-start',
    name: 'node',
    home: '',
    run: '',
  };
  const sibling = { ...member, pid: 202, started: 'sibling-start' };
  const groups: MacProcessGroup[] = [
    { pid: 200, started: 'exited-leader', group: 200, root: 100, uid: 123 },
    {
      pid: member.pid,
      started: member.started,
      group: 200,
      root: 100,
      uid: 123,
    },
  ];
  const run = {
    id: 'synthetic-run',
    pid: 100,
    home: '/tmp/synthetic-home',
    uid: 123,
    groups,
  };
  expect(orphanedProcesses([], [member, sibling], run, 'darwin')).toEqual([
    member,
    sibling,
  ]);
  expect(unverifiedMacProcesses([], [member, sibling], run)).toEqual([]);
  expect(orphanedProcesses([], [sibling], run, 'darwin')).toEqual([]);
  expect(unverifiedMacProcesses([], [sibling], run)).toEqual([sibling]);
  for (const changed of [
    { ...member, uid: 456 },
    { ...member, group: 300 },
    { ...member, started: 'reused-member' },
  ])
    expect(orphanedProcesses([], [changed, sibling], run, 'darwin')).toEqual(
      [],
    );
  const foreign = { ...member, uid: 456 };
  const foreignRun = { ...run, groups: [{ ...groups[1], uid: foreign.uid }] };
  expect(
    orphanedProcesses([], [foreign, sibling], foreignRun, 'darwin'),
  ).toEqual([]);
});
