import children from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import {
  type FileHandle,
  mkdir,
  mkdtemp,
  default as promises,
  realpath,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Effect, type Scope } from 'effect';
import { expect, it, vi } from 'vitest';
import { lockSession } from '../apps/cli/src/session-lock.ts';
import type { HostProcess } from '../scripts/lib/host-processes.ts';
import { observeKeychains } from '../scripts/lib/macos-keychains.ts';
import {
  type MacProcessGroup,
  readMacProcessGroups,
  recordMacProcessGroup,
  spawnMacFixtureProcess,
  stopMacProcessGroup,
} from '../scripts/lib/macos-process-groups.ts';
import { testEnvironment } from '../scripts/lib/test-environment.ts';
import {
  closeMacFixtureProcess,
  macFixtureProcessAlive,
  readMacFixtureProcess,
} from './support/macos-host-lifecycle.ts';
import {
  type PrivateMacKeychain,
  privateMacKeychain,
  requireFixtureKeychain,
  requireFreshKeychainHome,
} from './support/macos-keychain.ts';
import { registeredMacProcessGroups } from './support/macos-process-journal.ts';

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  return { ...actual, existsSync: vi.fn(actual.existsSync) };
});

it('E19: registration failure cleanup requires an unchanged owned kernel identity', () => {
  const record: MacProcessGroup = {
    pid: 12346,
    group: 12346,
    uid: userInfo().uid,
    started: 'Tue Oct  6 10:00:00 2026',
    root: 12340,
  };
  const current = {
    ...record,
    parent: 1,
    name: 'synthetic',
    home: '',
    run: '',
  } satisfies HostProcess;
  for (const observed of [
    undefined,
    { ...current, pid: current.pid + 1 },
    { ...current, started: 'different generation' },
    { ...current, uid: current.uid + 1 },
    { ...current, group: current.group + 1 },
  ]) {
    const inspect = vi.fn(() => observed);
    const kill = vi.fn(() => true as const);
    expect(stopMacProcessGroup(record, inspect, kill)).toBe(false);
    expect(inspect).toHaveBeenCalledWith(record.pid);
    expect(kill).not.toHaveBeenCalled();
  }
  const inspect = vi.fn(() => current);
  const kill = vi.fn(() => true as const);
  expect(stopMacProcessGroup(record, inspect, kill)).toBe(true);
  expect(kill).toHaveBeenCalledExactlyOnceWith(-record.group, 'SIGKILL');

  const foreign = { ...record, uid: record.uid + 1 };
  const foreignInspect = vi.fn(() => ({ ...current, uid: foreign.uid }));
  const foreignKill = vi.fn(() => true as const);
  expect(stopMacProcessGroup(foreign, foreignInspect, foreignKill)).toBe(false);
  expect(foreignInspect).not.toHaveBeenCalled();
  expect(foreignKill).not.toHaveBeenCalled();

  const failedInspect = vi.fn(() => {
    throw new Error('Synthetic kernel observation failure.');
  });
  const readerKill = vi.fn(() => true as const);
  expect(stopMacProcessGroup(record, failedInspect, readerKill)).toBe(false);
  expect(readerKill).not.toHaveBeenCalled();

  const failedKill = vi.fn(() => {
    throw new Error('Synthetic signal failure.');
  });
  expect(stopMacProcessGroup(record, inspect, failedKill)).toBe(false);
  expect(failedKill).toHaveBeenCalledExactlyOnceWith(-record.group, 'SIGKILL');
});

it.each(['file', 'directory', 'symlink'] as const)(
  'E19: pending registrations preserve uncertainty before journal reads (%s)',
  async (kind) => {
    const directory = await mkdtemp('/tmp/nook-process-pending-');
    const pending = resolve(directory, 'pending-before-spawn');
    const record: MacProcessGroup = {
      pid: 12346,
      group: 12346,
      uid: userInfo().uid,
      started: 'Tue Oct  6 10:00:00 2026',
      root: 12340,
    };
    try {
      await writeFile(
        resolve(directory, `${record.pid}.json`),
        JSON.stringify(record),
      );
      expect(await readMacProcessGroups(directory)).toEqual([record]);
      if (kind === 'file') await writeFile(pending, '');
      else if (kind === 'directory') await mkdir(pending);
      else await symlink(resolve(directory, 'absent'), pending);
      await expect(readMacProcessGroups(directory)).rejects.toThrow(/pending/i);
      await rm(pending, { recursive: true });
      expect(await readMacProcessGroups(directory)).toEqual([record]);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it.each([
  ['owned leader', (leader: HostProcess) => [leader], false, true],
  ['quiesced group', (_leader: HostProcess) => [], false, false],
  [
    'unrelated group',
    (leader: HostProcess) => [
      { ...leader, pid: leader.pid + 1, group: leader.pid + 1, parent: 1 },
    ],
    false,
    false,
  ],
  [
    'foreign parent',
    (leader: HostProcess) => [{ ...leader, parent: leader.parent + 1 }],
    true,
    false,
  ],
  [
    'different detached group',
    (leader: HostProcess) => [{ ...leader, group: leader.pid + 1 }],
    true,
    false,
  ],
  [
    'adopted group member',
    (leader: HostProcess) => [{ ...leader, pid: leader.pid + 1, parent: 1 }],
    true,
    false,
  ],
  [
    'foreign uid',
    (leader: HostProcess) => [{ ...leader, uid: userInfo().uid + 1 }],
    true,
    false,
  ],
  [
    'kernel read failure',
    (_leader: HostProcess) => {
      throw new Error('Synthetic kernel snapshot failure.');
    },
    true,
    false,
  ],
  ['missing executable', (_leader: HostProcess) => [], false, false],
] as const)(
  'E19: fixture spawn registration handles %s without native execution',
  async (name, snapshot, refuses, registered) => {
    const home = await mkdtemp('/tmp/nook-process-spawn-');
    const directory = resolve(home, 'global');
    const mirror = resolve(home, 'private');
    await mkdir(directory, { mode: 0o700 });
    await mkdir(mirror, { mode: 0o700 });
    vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
    vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
    const leader: HostProcess = {
      pid: 1_000_000_000,
      group: 1_000_000_000,
      parent: process.pid,
      uid: userInfo().uid,
      started: 'Tue Oct  6 10:00:00 2026',
      name: 'synthetic',
      home: '',
      run: '',
    };
    const child = new children.ChildProcess();
    if (name !== 'missing executable')
      Object.defineProperty(child, 'pid', { value: leader.pid });
    const launch = vi.fn(() => child);
    const inspect = vi.fn(() => snapshot(leader));
    const forbidden = () => {
      throw new Error('Pure registration keeper attempted native execution.');
    };
    const nativeSpawn = vi
      .spyOn(children, 'spawn')
      .mockImplementation(forbidden);
    const nativeRead = vi
      .spyOn(children, 'execFileSync')
      .mockImplementation(forbidden);
    const nativeSignal = vi
      .spyOn(process, 'kill')
      .mockImplementation(forbidden);
    syncBuiltinESMExports();
    try {
      if (refuses) {
        expect(() => spawnMacFixtureProcess(launch, mirror, inspect)).toThrow(
          'macOS fixture command could not register its process group.',
        );
        expect(await promises.readdir(directory)).toEqual([]);
        const entries = await promises.readdir(mirror);
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatch(/^pending-/);
        await expect(readMacProcessGroups(mirror)).rejects.toThrow(/pending/i);
      } else {
        expect(spawnMacFixtureProcess(launch, mirror, inspect)).toBe(child);
        const expected = registered
          ? [
              {
                pid: leader.pid,
                group: leader.pid,
                uid: userInfo().uid,
                started: 'Tue Oct  6 10:00:00 2026',
                root: process.pid,
              },
            ]
          : [];
        expect(await readMacProcessGroups(directory)).toEqual(expected);
        expect(await readMacProcessGroups(mirror)).toEqual(expected);
      }
      expect(launch).toHaveBeenCalledOnce();
      expect(nativeSpawn).not.toHaveBeenCalled();
      expect(nativeRead).not.toHaveBeenCalled();
      expect(nativeSignal).not.toHaveBeenCalled();
    } finally {
      nativeSpawn.mockRestore();
      nativeRead.mockRestore();
      nativeSignal.mockRestore();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
      await rm(home, { recursive: true, force: true });
    }
  },
);

it('E19: fixture spawn registration refuses a missing run root before launch', async () => {
  const home = await mkdtemp('/tmp/nook-process-preflight-');
  const directory = resolve(home, 'global');
  const mirror = resolve(home, 'private');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
  vi.stubEnv('NOOK_TEST_ROOT_PID', undefined);
  const child = new children.ChildProcess();
  Object.defineProperty(child, 'pid', { value: 1_000_000_000 });
  const launch = vi.fn(() => child);
  const inspect = vi.fn(() => []);
  const forbidden = () => {
    throw new Error('Pure registration keeper attempted native execution.');
  };
  const nativeSpawn = vi.spyOn(children, 'spawn').mockImplementation(forbidden);
  const nativeRead = vi
    .spyOn(children, 'execFileSync')
    .mockImplementation(forbidden);
  const nativeSignal = vi.spyOn(process, 'kill').mockImplementation(forbidden);
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    try {
      spawnMacFixtureProcess(launch, mirror, inspect);
    } catch (error) {
      failure = error;
    }
    expect(launch).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain('isolated process-group registry');
    expect(await promises.readdir(directory)).toEqual([]);
    expect(await promises.readdir(mirror)).toEqual([]);
    expect(inspect).not.toHaveBeenCalled();
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(nativeSignal).not.toHaveBeenCalled();
  } finally {
    nativeSpawn.mockRestore();
    nativeRead.mockRestore();
    nativeSignal.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it('E19: a missing private journal refuses a pure launch before any callback', async () => {
  const home = await mkdtemp('/tmp/nook-process-private-preflight-');
  const directory = resolve(home, 'global');
  const mirror = resolve(home, 'absent-private');
  await mkdir(directory, { mode: 0o700 });
  vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
  vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
  const child = new children.ChildProcess();
  const launch = vi.fn(() => child);
  const inspect = vi.fn(() => []);
  const forbidden = () => {
    throw new Error('Pure registration keeper attempted native execution.');
  };
  const nativeSpawn = vi.spyOn(children, 'spawn').mockImplementation(forbidden);
  const nativeRead = vi
    .spyOn(children, 'execFileSync')
    .mockImplementation(forbidden);
  const nativeSignal = vi.spyOn(process, 'kill').mockImplementation(forbidden);
  syncBuiltinESMExports();
  let failure: unknown;
  try {
    try {
      spawnMacFixtureProcess(launch, mirror, inspect);
    } catch (error) {
      failure = error;
    }
    expect(launch).not.toHaveBeenCalled();
    expect(failure).toBeInstanceOf(Error);
    expect(String(failure)).toContain(
      'macOS fixture command could not register its process group.',
    );
    expect(await promises.readdir(directory)).toEqual([]);
    expect(existsSync(mirror)).toBe(false);
    expect(inspect).not.toHaveBeenCalled();
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(nativeSignal).not.toHaveBeenCalled();
  } finally {
    nativeSpawn.mockRestore();
    nativeRead.mockRestore();
    nativeSignal.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it('E19: a later successful spawn preserves an earlier unresolved registration', async () => {
  const home = await mkdtemp('/tmp/nook-process-pending-collision-');
  const directory = resolve(home, 'global');
  const mirror = resolve(home, 'private');
  await mkdir(directory, { mode: 0o700 });
  await mkdir(mirror, { mode: 0o700 });
  vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
  vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
  const unresolved = new children.ChildProcess();
  Object.defineProperty(unresolved, 'pid', { value: 1_000_000_000 });
  const failedLaunch = vi.fn(() => unresolved);
  const failedInspect = vi.fn(() => {
    throw new Error('Synthetic kernel snapshot failure.');
  });
  const completed = new children.ChildProcess();
  const successfulLaunch = vi.fn(() => completed);
  const successfulInspect = vi.fn(() => []);
  const forbidden = () => {
    throw new Error('Pure registration keeper attempted native execution.');
  };
  const nativeSpawn = vi.spyOn(children, 'spawn').mockImplementation(forbidden);
  const nativeRead = vi
    .spyOn(children, 'execFileSync')
    .mockImplementation(forbidden);
  const nativeSignal = vi.spyOn(process, 'kill').mockImplementation(forbidden);
  syncBuiltinESMExports();
  try {
    expect(() =>
      spawnMacFixtureProcess(failedLaunch, mirror, failedInspect),
    ).toThrow('macOS fixture command could not register its process group.');
    const pending = await promises.readdir(mirror);
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatch(/^pending-/);
    await expect(readMacProcessGroups(mirror)).rejects.toThrow(/pending/i);

    expect(
      spawnMacFixtureProcess(successfulLaunch, mirror, successfulInspect),
    ).toBe(completed);
    expect(await promises.readdir(mirror)).toEqual(pending);
    await expect(readMacProcessGroups(mirror)).rejects.toThrow(/pending/i);
    expect(await promises.readdir(directory)).toEqual([]);
    expect(failedLaunch).toHaveBeenCalledOnce();
    expect(failedInspect).toHaveBeenCalledOnce();
    expect(successfulLaunch).toHaveBeenCalledOnce();
    expect(successfulInspect).not.toHaveBeenCalled();
    expect(nativeSpawn).not.toHaveBeenCalled();
    expect(nativeRead).not.toHaveBeenCalled();
    expect(nativeSignal).not.toHaveBeenCalled();
  } finally {
    nativeSpawn.mockRestore();
    nativeRead.mockRestore();
    nativeSignal.mockRestore();
    syncBuiltinESMExports();
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it('E17: misdirected login or default keychains fail the fixture gate before any write', async () => {
  const home = await realpath(await mkdtemp('/tmp/nook-keychain-gate-'));
  try {
    await mkdir(resolve(home, 'Library/Keychains'), { recursive: true });
    const env = testEnvironment(home);
    for (const wrong of ['login-keychain', 'default-keychain']) {
      const observer = vi.fn(async (args: string[]) => ({
        status: 0,
        stdout: `"${args[0] === wrong ? '/tmp' : home}/Library/Keychains/login.keychain-db"\n`,
        stderr: '',
      }));
      await expect(requireFixtureKeychain(home, env, observer)).rejects.toThrow(
        /No write was attempted/,
      );
      expect(
        observer.mock.calls.every(([args]) =>
          ['login-keychain', 'default-keychain'].includes(args[0]),
        ),
      ).toBe(true);
    }
    const observer = vi.fn();
    await expect(
      requireFixtureKeychain(
        home,
        { ...env, HOME: '/tmp/misdirected-home' },
        observer,
      ),
    ).rejects.toThrow('misdirected');
    expect(observer).not.toHaveBeenCalled();
    for (const invalid of [
      {
        status: 1,
        stdout: `"${home}/Library/Keychains/login.keychain-db"`,
        stderr: '',
      },
      { status: 0, stdout: '', stderr: '' },
      { status: 0, stdout: home, stderr: '' },
    ]) {
      await expect(
        requireFixtureKeychain(home, env, async () => invalid),
      ).rejects.toThrow('No write was attempted');
    }
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('E17: creation preflight rejects a nonempty search list or an existing login keychain', async () => {
  const home = await realpath(await mkdtemp('/tmp/nook-keychain-preflight-'));
  try {
    const env = testEnvironment(home);
    const missing = {
      status: 1,
      stdout: '',
      stderr: 'The specified keychain could not be found.',
    };
    const empty = { status: 0, stdout: '', stderr: '' };
    await requireFreshKeychainHome(home, env, async (args) =>
      args[0] === 'login-keychain' ? missing : empty,
    );
    for (const unsafe of ['search', 'login']) {
      await expect(
        requireFreshKeychainHome(home, env, async (args) =>
          args[0] === 'login-keychain'
            ? unsafe === 'login'
              ? { ...empty, stdout: '"/synthetic/existing"' }
              : missing
            : unsafe === 'search'
              ? { ...empty, stdout: '"/synthetic/existing"' }
              : empty,
        ),
      ).rejects.toThrow('No write was attempted');
    }
    for (const [search, login] of [
      [{ ...empty, status: 1 }, missing],
      [empty, { ...missing, status: 0 }],
      [empty, { ...missing, stderr: 'Unrelated failure' }],
      [empty, { ...missing, stdout: 'unexpected output' }],
    ]) {
      await expect(
        requireFreshKeychainHome(home, env, async (args) =>
          args[0] === 'login-keychain' ? login : search,
        ),
      ).rejects.toThrow('No write was attempted');
    }
    const observe = vi.fn(async () => empty);
    await expect(
      requireFreshKeychainHome(
        home,
        { ...env, HOME: resolve(home, 'wrong') },
        observe,
      ),
    ).rejects.toThrow('fresh resolved temporary HOME');
    const owner = userInfo().homedir;
    await expect(
      requireFreshKeychainHome(owner, { HOME: owner }, observe),
    ).rejects.toThrow('fresh resolved temporary HOME');
    const alias = resolve(home, 'alias');
    const { symlink } = await import('node:fs/promises');
    await symlink(home, alias);
    await expect(
      requireFreshKeychainHome(alias, { HOME: home }, observe),
    ).rejects.toThrow('fresh resolved temporary HOME');
    expect(observe).not.toHaveBeenCalled();
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it.runIf(process.platform === 'darwin')(
  'the fixture refuses local creation without explicit runner opt-in, even with CI=true',
  async () => {
    vi.stubEnv('NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP', undefined);
    vi.stubEnv('CI', 'true');
    const launch = vi.spyOn(children, 'spawn').mockImplementation(() => {
      throw new Error('Fixture launched before explicit bootstrap opt-in.');
    });
    syncBuiltinESMExports();
    try {
      await expect(privateMacKeychain()).rejects.toThrow(
        'https://github.com/taecontrol/nook/issues/40',
      );
      expect(launch).not.toHaveBeenCalled();
    } finally {
      launch.mockRestore();
      syncBuiltinESMExports();
      vi.unstubAllEnvs();
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E17: real security resolves login and default inside temporary HOME before CLI children are allowed',
  async () => {
    const fixture = await privateMacKeychain();
    try {
      await requireFixtureKeychain(fixture.home, testEnvironment(fixture.home));
      expect(await observeKeychains(fixture.home)).toEqual({
        searchList: `"${fixture.keychain}"`,
        defaultKeychain: `"${fixture.keychain}"`,
        loginKeychain: `"${fixture.keychain}"`,
      });
    } finally {
      await fixture.close();
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E17: fixture initialization refuses a misdirected post-create gate before returning a CLI launcher',
  async () => {
    let accepted: Awaited<ReturnType<typeof privateMacKeychain>> | undefined;
    const initialization = privateMacKeychain({
      observeGate: async () => ({
        status: 0,
        stdout: '"/tmp/Library/Keychains/login.keychain-db"',
        stderr: '',
      }),
    }).then((fixture) => {
      accepted = fixture;
    });
    try {
      await expect(initialization).rejects.toThrow('No write was attempted');
      expect(accepted).toBeUndefined();
    } finally {
      await accepted?.close();
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E17: a missing keychain observation refuses every CLI launch',
  async () => {
    const { existsSync: physicalExists } =
      await vi.importActual<typeof import('node:fs')>('node:fs');
    const fixture = await privateMacKeychain();
    const observedExists = vi.mocked(existsSync);
    let launched: ReturnType<PrivateMacKeychain['start']> | undefined;
    try {
      expect(physicalExists(fixture.keychain)).toBe(true);
      observedExists.mockImplementation((path) =>
        path === fixture.keychain ? false : physicalExists(path),
      );
      expect(() => {
        launched = fixture.start(['whoami']);
      }).toThrow('The fixture keychain must exist before every command.');
      expect(physicalExists(fixture.keychain)).toBe(true);
    } finally {
      observedExists.mockImplementation(physicalExists);
      launched?.kill('SIGKILL');
      await launched?.done;
      await fixture.close();
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E17: a CLI launch refuses PATH without the fixture shims first',
  async () => {
    const fixture = await privateMacKeychain();
    let launched: ReturnType<PrivateMacKeychain['start']> | undefined;
    try {
      expect(() => {
        launched = fixture.start(['whoami'], { PATH: '/usr/bin:/bin' });
      }).toThrow('Fixture shims must be first on PATH.');
    } finally {
      launched?.kill('SIGKILL');
      await launched?.done;
      await fixture.close();
    }
  },
);

it.runIf(process.platform === 'darwin').each(['success', 'failure'])(
  'E14: a %s terminal scope releases the kernel lock while its handle remains reachable',
  async (terminal) => {
    const fixture = await privateMacKeychain();
    const retained: FileHandle[] = [];
    vi.stubEnv('HOME', fixture.home);
    const acquire = (
      lockSession as Effect.Effect<FileHandle, unknown, Scope.Scope>
    ).pipe(Effect.tap((handle) => Effect.sync(() => retained.push(handle))));
    try {
      const first = Effect.scoped(
        terminal === 'failure'
          ? acquire.pipe(Effect.flatMap(() => Effect.fail('terminal failure')))
          : acquire,
      );
      if (terminal === 'failure') {
        expect(
          await Effect.runPromiseExit(first).then((exit) => exit._tag),
        ).toBe('Failure');
      } else {
        await Effect.runPromise(first);
      }
      await Effect.runPromise(Effect.scoped(acquire));
      expect(retained).toHaveLength(2);
    } finally {
      await Promise.all(retained.map((handle) => handle.close()));
      vi.unstubAllEnvs();
      await fixture.close();
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E19: directory setup failure removes its empty HOME before any fixture command',
  async () => {
    const root = await realpath(await mkdtemp('/tmp/nook-keychain-setup-'));
    const create = promises.mkdir;
    const directorySpy = vi
      .spyOn(promises, 'mkdir')
      .mockImplementation(async (path, options) => {
        if (String(path).startsWith(`${root}/`))
          throw new Error('Synthetic setup directory failure.');
        return create(path, options);
      });
    const launchSpy = vi.spyOn(children, 'spawn').mockImplementation(() => {
      throw new Error('Fixture command started before directory setup.');
    });
    syncBuiltinESMExports();
    try {
      await expect(privateMacKeychain({ tempRoot: root })).rejects.toThrow(
        'Synthetic setup directory failure.',
      );
      expect(launchSpy).not.toHaveBeenCalled();
      expect(await promises.readdir(root)).toEqual([]);
    } finally {
      directorySpy.mockRestore();
      launchSpy.mockRestore();
      syncBuiltinESMExports();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.runIf(process.platform === 'darwin')(
  'E19: fixture close stops its known CLI before the first backend command',
  async () => {
    const fixture = await privateMacKeychain();
    let cli: ReturnType<PrivateMacKeychain['start']> | undefined;
    let identity: ReturnType<typeof readMacFixtureProcess>;
    try {
      const preload = resolve(fixture.home, 'pause-before-cli.mjs');
      await writeFile(
        preload,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HOME + '/cli-pause-ready', 'ready');
await new Promise(() => { setInterval(() => {}, 1000); });
`,
      );
      cli = fixture.start(['whoami'], {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      identity = readMacFixtureProcess(cli.child.pid);
      expect(identity?.uid).toBe(userInfo().uid);
      await expect
        .poll(() => existsSync(resolve(fixture.home, 'cli-pause-ready')))
        .toBe(true);
      expect(existsSync(resolve(fixture.home, 'argv'))).toBe(false);
      expect(existsSync(resolve(fixture.home, 'opened'))).toBe(false);
      await fixture.close();
      await cli.done;
      expect(macFixtureProcessAlive(identity)).toBe(false);
      expect(existsSync(fixture.home)).toBe(false);
    } finally {
      await closeMacFixtureProcess(identity);
      await cli?.done;
      await fixture.close();
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: a missing private journal rejects registration before launching any CLI',
  async () => {
    const fixture = await privateMacKeychain();
    const journal = resolve(fixture.home, 'fixture-process-groups');
    const backup = resolve(fixture.home, 'fixture-process-groups-backup');
    let child: ReturnType<typeof children.spawn> | undefined;
    let identity: ReturnType<typeof readMacFixtureProcess>;
    let closed: Promise<void> | undefined;
    const launch = children.spawn;
    const launchSpy = vi
      .spyOn(children, 'spawn')
      .mockImplementation((file, args, options) => {
        const launched = launch(file, args, options);
        child = launched;
        closed = new Promise((accept) => {
          launched.once('close', () => accept());
        });
        identity = readMacFixtureProcess(launched.pid);
        expect(identity?.uid).toBe(userInfo().uid);
        expect(identity?.group).toBe(launched.pid);
        return launched;
      });
    syncBuiltinESMExports();
    try {
      const preload = resolve(fixture.home, 'pause-before-cli.mjs');
      await writeFile(
        preload,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HOME + '/cli-pause-ready', 'ready');
await new Promise(() => { setInterval(() => {}, 1000); });
`,
      );
      await rename(journal, backup);
      expect(() =>
        fixture.start(['whoami'], {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        }),
      ).toThrow('macOS fixture command could not register its process group.');
      expect(launchSpy).not.toHaveBeenCalled();
      expect(existsSync(fixture.home)).toBe(true);
      expect(existsSync(resolve(fixture.home, 'argv'))).toBe(false);
      expect(existsSync(resolve(fixture.home, 'opened'))).toBe(false);
    } finally {
      launchSpy.mockRestore();
      syncBuiltinESMExports();
      if (existsSync(backup)) await rename(backup, journal);
      await releaseKnownCli(fixture, child, identity, closed);
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: failed CLI registration with blocked termination preserves HOME and its known child',
  async () => {
    const fixture = await privateMacKeychain();
    let child: ReturnType<typeof children.spawn> | undefined;
    let identity: ReturnType<typeof readMacFixtureProcess>;
    let closed: Promise<void> | undefined;
    const launch = children.spawn;
    const kill = process.kill;
    const launchSpy = vi
      .spyOn(children, 'spawn')
      .mockImplementation((file, args, options) => {
        const launched = launch(file, args, options);
        child = launched;
        closed = new Promise((accept) => {
          launched.once('close', () => accept());
        });
        identity = readMacFixtureProcess(launched.pid);
        expect(identity?.uid).toBe(userInfo().uid);
        expect(identity?.group).toBe(launched.pid);
        mkdirSync(
          resolve(
            fixture.home,
            'fixture-process-groups',
            `${launched.pid}.json`,
          ),
        );
        return launched;
      });
    const killSpy = vi
      .spyOn(process, 'kill')
      .mockImplementation((pid, signal) => {
        if (
          identity &&
          pid === -identity.group &&
          signal === 'SIGKILL' &&
          macFixtureProcessAlive(identity)
        )
          throw new Error('Synthetic verified group termination blocked.');
        return kill(pid, signal);
      });
    syncBuiltinESMExports();
    try {
      const preload = resolve(fixture.home, 'pause-before-cli.mjs');
      await writeFile(
        preload,
        `import { writeFileSync } from 'node:fs';
writeFileSync(process.env.HOME + '/cli-pause-ready', 'ready');
await new Promise(() => { setInterval(() => {}, 1000); });
`,
      );
      expect(() =>
        fixture.start(['whoami'], {
          NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
        }),
      ).toThrow('macOS fixture command could not register its process group.');
      await expect
        .poll(() => existsSync(resolve(fixture.home, 'cli-pause-ready')))
        .toBe(true);
      expect(macFixtureProcessAlive(identity)).toBe(true);
      expect(existsSync(resolve(fixture.home, 'argv'))).toBe(false);
      expect(existsSync(resolve(fixture.home, 'opened'))).toBe(false);
      await expect(fixture.close()).rejects.toThrow(
        'temporary HOME was preserved',
      );
      expect(existsSync(fixture.home)).toBe(true);
      expect(macFixtureProcessAlive(identity)).toBe(true);
    } finally {
      launchSpy.mockRestore();
      killSpy.mockRestore();
      syncBuiltinESMExports();
      await releaseKnownCli(fixture, child, identity, closed);
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: failed tracked child registration preserves HOME before any backend command',
  async () => {
    const fixture = await privateMacKeychain();
    let cli: ReturnType<PrivateMacKeychain['start']> | undefined;
    let cliIdentity: ReturnType<typeof readMacFixtureProcess>;
    let descendant: ReturnType<typeof readMacFixtureProcess>;
    try {
      const preload = resolve(fixture.home, 'failed-tracker-before-cli.mjs');
      const moduleUrl = (file: string) => pathToFileURL(resolve(file)).href;
      await writeFile(
        preload,
        `
import children from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { userInfo } from 'node:os';
import { readMacFixtureProcess, macFixtureProcessAlive } from ${JSON.stringify(moduleUrl('tests/support/macos-host-lifecycle.ts'))};
import { trackMacFixtureProcesses } from ${JSON.stringify(moduleUrl('scripts/lib/macos-process-groups.ts'))};
import { testEnvironment } from ${JSON.stringify(moduleUrl('scripts/lib/test-environment.ts'))};
const journal = ${JSON.stringify(resolve(fixture.home, 'fixture-process-groups'))};
const launch = children.spawn;
const kill = process.kill;
let identity;
children.spawn = (file, args, options) => {
  const child = launch(file, args, options);
  identity = readMacFixtureProcess(child.pid);
  if (!identity || identity.uid !== userInfo().uid || identity.group !== child.pid)
    throw new Error('Independent tracked-child identity capture failed.');
  writeFileSync(process.env.HOME + '/tracker-child.json', JSON.stringify(identity));
  mkdirSync(journal + '/' + child.pid + '.json');
  return child;
};
process.kill = (pid, signal) => {
  if (identity && pid === -identity.group && signal === 'SIGKILL' && macFixtureProcessAlive(identity))
    throw new Error('Synthetic verified tracked-child termination blocked.');
  return kill(pid, signal);
};
syncBuiltinESMExports();
trackMacFixtureProcesses(journal);
try {
  children.spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: testEnvironment(process.env.HOME, { NODE_OPTIONS: undefined }),
    detached: true, stdio: 'ignore',
  });
} catch (error) {
  writeFileSync(process.env.HOME + '/tracker-rejection', error.message);
}
await new Promise(() => { setInterval(() => {}, 1000); });
`,
      );
      cli = fixture.start(['whoami'], {
        NODE_OPTIONS: `--import=${pathToFileURL(preload).href}`,
      });
      cliIdentity = readMacFixtureProcess(cli.child.pid);
      expect(cliIdentity?.uid).toBe(userInfo().uid);
      await expect
        .poll(() => existsSync(resolve(fixture.home, 'tracker-rejection')))
        .toBe(true);
      const captured = JSON.parse(
        await promises.readFile(
          resolve(fixture.home, 'tracker-child.json'),
          'utf8',
        ),
      );
      descendant = readMacFixtureProcess(captured.pid);
      expect(descendant).toEqual(captured);
      expect(descendant?.uid).toBe(userInfo().uid);
      expect(
        await promises.readFile(
          resolve(fixture.home, 'tracker-rejection'),
          'utf8',
        ),
      ).toBe('macOS fixture command could not register its process group.');
      expect(macFixtureProcessAlive(cliIdentity)).toBe(true);
      expect(macFixtureProcessAlive(descendant)).toBe(true);
      expect(existsSync(resolve(fixture.home, 'argv'))).toBe(false);
      expect(existsSync(resolve(fixture.home, 'opened'))).toBe(false);
      await expect(fixture.close()).rejects.toThrow(
        'temporary HOME was preserved',
      );
      expect(existsSync(fixture.home)).toBe(true);
      expect(macFixtureProcessAlive(descendant)).toBe(true);
    } finally {
      await releaseFailedTracker(fixture, cli, cliIdentity, descendant);
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: fixture close stops an adopted security shim before removing HOME',
  async () => {
    const stalled = await stalledFixture();
    const { fixture } = stalled;
    const erase = promises.rm;
    let erasedWhileShimAlive = false;
    let removalObserved = false;
    const eraseSpy = vi
      .spyOn(promises, 'rm')
      .mockImplementation(async (path, options) => {
        if (String(path) === fixture.home) {
          removalObserved = true;
          erasedWhileShimAlive = macFixtureProcessAlive(stalled.shimIdentity);
        }
        return erase(path, options);
      });
    syncBuiltinESMExports();
    try {
      await adoptStalledFixture(stalled);
      await fixture.close();
      expect(removalObserved).toBe(true);
      expect(
        erasedWhileShimAlive,
        'HOME is removed only after its adopted shim exits',
      ).toBe(false);
      expect(
        macFixtureProcessAlive(stalled.shimIdentity),
        'fixture.close leaves no adopted security shim',
      ).toBe(false);
      expect(existsSync(fixture.home)).toBe(false);
    } finally {
      eraseSpy.mockRestore();
      syncBuiltinESMExports();
      await releaseStalledFixture(stalled);
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: failed private journal registration stops only its unchanged command group',
  async () => {
    const stalled = await stalledFixture();
    try {
      await adoptStalledFixture(stalled);
      const obstruction = resolve(stalled.fixture.home, 'blocked-journal');
      await writeFile(obstruction, 'synthetic journal obstruction');
      expect(() =>
        recordMacProcessGroup(
          stalled.shimIdentity?.pid,
          undefined,
          obstruction,
        ),
      ).toThrow('macOS fixture command could not register its process group.');
      await expect
        .poll(() => macFixtureProcessAlive(stalled.shimIdentity))
        .toBe(false);
    } finally {
      await releaseStalledFixture(stalled);
    }
  },
  20_000,
);

it.runIf(process.platform === 'darwin')(
  'E19: closing one fixture stops only its own CLI and security groups',
  async () => {
    const first = await stalledFixture();
    let second: StalledFixture | undefined;
    try {
      second = await stalledFixture();
      await first.fixture.close();
      await first.cli?.done;
      expect(macFixtureProcessAlive(first.cliIdentity)).toBe(false);
      expect(macFixtureProcessAlive(first.shimIdentity)).toBe(false);
      expect(existsSync(first.fixture.home)).toBe(false);
      expect(macFixtureProcessAlive(second.cliIdentity)).toBe(true);
      expect(macFixtureProcessAlive(second.shimIdentity)).toBe(true);
      expect(existsSync(second.fixture.home)).toBe(true);
    } finally {
      await releaseStalledFixture(second);
      await releaseStalledFixture(first);
    }
  },
  20_000,
);

it
  .runIf(process.platform === 'darwin')
  .each([
    'ambiguous generation',
    'blocked SIGKILL',
    'missing journal',
    'foreign journal root',
  ] as const)(
  'E19: %s refuses fixture cleanup and preserves HOME with its adopted shim alive',
  async (failure) => {
    const stalled = await stalledFixture();
    const { fixture } = stalled;
    let restore: (() => Promise<void>) | undefined;
    try {
      await adoptStalledFixture(stalled);
      const journal = resolve(fixture.home, 'fixture-process-groups');
      if (
        failure === 'ambiguous generation' ||
        failure === 'foreign journal root'
      ) {
        const file = resolve(journal, `${stalled.shimIdentity?.pid}.json`);
        const record = await promises.readFile(file, 'utf8');
        const identity = JSON.parse(record);
        await writeFile(
          file,
          JSON.stringify({
            ...identity,
            ...(failure === 'ambiguous generation'
              ? { started: 'stale-fixture-generation' }
              : { root: identity.root + 1 }),
          }),
        );
        restore = async () => {
          if (existsSync(journal)) await writeFile(file, record);
        };
      } else if (failure === 'blocked SIGKILL') {
        const kill = process.kill;
        const blocked = vi
          .spyOn(process, 'kill')
          .mockImplementation((pid, signal) => {
            if (
              pid === stalled.shimIdentity?.pid &&
              macFixtureProcessAlive(stalled.shimIdentity)
            )
              return true;
            return kill(pid, signal);
          });
        restore = async () => {
          blocked.mockRestore();
        };
      } else {
        const backup = resolve(fixture.home, 'fixture-process-groups-backup');
        await rename(journal, backup);
        restore = async () => {
          if (existsSync(backup)) await rename(backup, journal);
        };
      }
      await expect(fixture.close()).rejects.toThrow(
        'temporary HOME was preserved',
      );
      expect(existsSync(fixture.home)).toBe(true);
      expect(macFixtureProcessAlive(stalled.shimIdentity)).toBe(true);
    } finally {
      await restore?.();
      await releaseStalledFixture(stalled);
    }
  },
  20_000,
);

type StalledFixture = {
  fixture: PrivateMacKeychain;
  cli: ReturnType<PrivateMacKeychain['start']> | undefined;
  cliIdentity: ReturnType<typeof readMacFixtureProcess>;
  shimIdentity: ReturnType<typeof readMacFixtureProcess>;
};

async function stalledFixture(): Promise<StalledFixture> {
  const state: StalledFixture = {
    fixture: await privateMacKeychain(),
    cli: undefined,
    cliIdentity: undefined,
    shimIdentity: undefined,
  };
  try {
    await writeFile(
      resolve(state.fixture.shim, 'security'),
      '#!/bin/sh\nprintf "%s" "$$" > "$HOME/fixture-close-pid"\nexec /bin/sleep 300\n',
      { mode: 0o700 },
    );
    state.cli = state.fixture.start(['login', 'https://synthetic.invalid']);
    state.cliIdentity = readMacFixtureProcess(state.cli.child.pid);
    expect(state.cliIdentity?.uid).toBe(userInfo().uid);
    await expect
      .poll(() => existsSync(resolve(state.fixture.home, 'fixture-close-pid')))
      .toBe(true);
    const pid = Number(
      await promises.readFile(
        resolve(state.fixture.home, 'fixture-close-pid'),
        'utf8',
      ),
    );
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    state.shimIdentity = readMacFixtureProcess(pid);
    expect(state.shimIdentity?.uid).toBe(userInfo().uid);
    expect(state.shimIdentity?.group).toBe(pid);
    await registeredMacProcessGroups(
      resolve(state.fixture.home, 'fixture-process-groups'),
    );
    return state;
  } catch (error) {
    await releaseStalledFixture(state);
    throw error;
  }
}

async function adoptStalledFixture(state: StalledFixture) {
  await closeMacFixtureProcess(state.cliIdentity);
  await state.cli?.done;
  expect(macFixtureProcessAlive(state.shimIdentity)).toBe(true);
}

async function releaseStalledFixture(state: StalledFixture | undefined) {
  if (!state) return;
  await closeMacFixtureProcess(state.cliIdentity);
  await state.cli?.done;
  await closeMacFixtureProcess(state.shimIdentity);
  await state.fixture.close();
}

async function releaseKnownCli(
  fixture: PrivateMacKeychain,
  child: ReturnType<typeof children.spawn> | undefined,
  identity: ReturnType<typeof readMacFixtureProcess>,
  closed: Promise<unknown> | undefined,
) {
  if (child && !identity)
    throw new Error(
      'Independent CLI identity capture failed; temporary HOME was preserved.',
    );
  await closeMacFixtureProcess(identity);
  await closed;
  await rm(fixture.home, { recursive: true, force: true });
}

async function releaseFailedTracker(
  fixture: PrivateMacKeychain,
  cli: ReturnType<PrivateMacKeychain['start']> | undefined,
  identity: ReturnType<typeof readMacFixtureProcess>,
  descendant: ReturnType<typeof readMacFixtureProcess>,
) {
  if (!identity || !descendant)
    throw new Error(
      'Independent tracked identities are missing; temporary HOME was preserved.',
    );
  await closeMacFixtureProcess(identity);
  await cli?.done;
  await closeMacFixtureProcess(descendant);
  await rm(fixture.home, { recursive: true, force: true });
}
