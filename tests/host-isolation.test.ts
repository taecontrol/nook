import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  rename,
  rm,
  symlink,
  utimes,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { expect, it, vi } from 'vitest';
import { startHostIsolation } from '../scripts/lib/host-isolation.ts';
import {
  type HostProcess,
  killOrphans,
  orphanedProcesses,
  readHostProcess,
  snapshotProcesses,
} from '../scripts/lib/host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintDirectory,
  fingerprintHost,
  ownerResources,
} from '../scripts/lib/host-resources.ts';
import * as environmentSupport from '../scripts/lib/test-environment.ts';
import {
  temporaryTestHome,
  testEnvironment,
  unavailableSessionBus,
} from '../scripts/lib/test-environment.ts';
import { activationBus } from './support/activation-bus.ts';
import { privateKeyring } from './support/cli.ts';
import { runtime } from './support/runtime.ts';

it.each(['keyrings', 'nook'] as const)(
  'an owner %s write fails the tripwire without exposing file contents',
  async (name) => {
    const home = await temporaryTestHome();
    const directory = resolve(
      home,
      name === 'keyrings' ? '.local/share/keyrings' : '.config/nook',
    );
    const resources = { directories: [directory] };
    try {
      const before = await fingerprintHost(resources);
      expect(before.directories[directory]).toBe('absent');
      assertHostUnchanged(before, await fingerprintHost(resources));
      await mkdir(directory, { recursive: true });
      await writeFile(
        resolve(directory, 'synthetic-file'),
        'synthetic-private-content',
      );
      const after = await fingerprintHost(resources);
      const message =
        name === 'keyrings'
          ? 'owner keyring directory changed'
          : 'owner Nook configuration directory changed';
      expect(() => assertHostUnchanged(before, after)).toThrow(
        `Host isolation failed: ${message} (${JSON.stringify(directory)}): "." added, "./synthetic-file" added.`,
      );
      try {
        assertHostUnchanged(before, after);
      } catch (error) {
        expect(String(error).includes('synthetic-private-content')).toBe(false);
        expect(String(error).includes('synthetic-file')).toBe(true);
      }
      await rm(directory, { recursive: true });
      assertHostUnchanged(before, await fingerprintHost(resources));
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each(['keyrings', 'nook'] as const)(
  'the %s tripwire distinguishes owner metadata refreshes from added or removed entries without following symlinks',
  async (name) => {
    const home = await temporaryTestHome();
    const directory = resolve(
      home,
      name === 'keyrings' ? 'data/keyrings' : 'config/nook',
    );
    const file = resolve(directory, 'nested/item');
    try {
      await mkdir(resolve(file, '..'), { recursive: true });
      await writeFile(file, 'synthetic');
      await symlink(resolve(home, 'config'), resolve(directory, 'outside'));
      const resources = { directories: [directory] };
      await utimes(file, new Date(1000), new Date(1000));
      await utimes(resolve(file, '..'), new Date(2000), new Date(2000));
      await utimes(resources.directories[0], new Date(3000), new Date(3000));
      const before = await fingerprintHost(resources);
      await utimes(file, new Date(4000), new Date(4000));
      const changed = await fingerprintHost(resources);
      if (name === 'keyrings') assertHostUnchanged(before, changed);
      else
        expect(() => assertHostUnchanged(before, changed)).toThrow(
          '"./nested/item" mtime changed',
        );
      await writeFile(file, 'different-length-synthetic');
      await utimes(file, new Date(1000), new Date(1000));
      const resized = await fingerprintHost(resources);
      if (name === 'keyrings') assertHostUnchanged(before, resized);
      else
        expect(() => assertHostUnchanged(before, resized)).toThrow(
          '"./nested/item" size changed',
        );
      await writeFile(file, 'synthetic');
      await utimes(file, new Date(1000), new Date(1000));
      assertHostUnchanged(before, await fingerprintHost(resources));
      const renamedFile = resolve(file, '../next');
      await rename(file, renamedFile);
      await utimes(resolve(file, '..'), new Date(2000), new Date(2000));
      await utimes(resources.directories[0], new Date(3000), new Date(3000));
      const renamed = await fingerprintHost(resources);
      expect(() => assertHostUnchanged(before, renamed)).toThrow(
        '"./nested/item" removed, "./nested/next" added',
      );
      await rm(renamedFile);
      const deleted = await fingerprintHost(resources);
      expect(() => assertHostUnchanged(before, deleted)).toThrow(
        '"./nested/item" removed',
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it('the tripwire fingerprints the destination of a symlinked owner resource root', async () => {
  const home = await temporaryTestHome();
  const root = resolve(home, 'keyrings');
  try {
    await symlink(resolve(home, 'data'), root);
    const resources = { directories: [root] };
    const before = await fingerprintHost(resources);
    await writeFile(resolve(home, 'data/synthetic-entry'), 'synthetic-only');
    const after = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, after)).toThrow(
      'owner keyring directory changed',
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('an existing keyring entry becoming a directory fails on kind and root removal fails on presence', async () => {
  const home = await temporaryTestHome();
  const directory = resolve(home, 'data/keyrings');
  const entry = resolve(directory, 'synthetic-entry');
  try {
    await mkdir(directory);
    await writeFile(entry, 'synthetic-only');
    const resources = { directories: [directory] };
    const before = await fingerprintHost(resources);
    await rm(entry);
    await mkdir(entry);
    const after = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, after)).toThrow(
      '"./synthetic-entry" kind changed',
    );
    await rm(directory, { recursive: true });
    const removed = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, removed)).toThrow('"." removed');
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

it('the real user home wins over HOME and absent owner resources stay absent', async () => {
  const owner = {
    homedir: '/tmp/synthetic-real-owner',
    uid: 12345,
    gid: 12345,
    username: 'synthetic-owner',
    shell: '/bin/sh',
  };
  const paths = ownerResources(
    {
      HOME: '/tmp/forged-home',
      XDG_DATA_HOME: '/tmp/synthetic-owner-data',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/absent-owner-bus',
    },
    owner,
  );
  expect(paths.directories).toEqual([
    '/tmp/synthetic-real-owner/.local/share/keyrings',
    '/tmp/synthetic-owner-data/keyrings',
    '/tmp/synthetic-real-owner/.config/nook',
  ]);
  expect(Object.keys(paths)).toEqual(['directories']);
  expect(
    ownerResources({ XDG_DATA_HOME: 'relative' }, owner).directories,
  ).toHaveLength(2);
  expect(
    ownerResources(
      {
        HOME: '/tmp/nook-test-run-nested',
        XDG_DATA_HOME: '/tmp/nook-test-run-nested/data',
      },
      owner,
    ).directories,
  ).toHaveLength(2);
});

it('filesystem fingerprinting never contacts a reachable Secret Service or creates an owner keyring directory', async () => {
  const fixture = await activationBus();
  const resources = ownerResources(
    {
      HOME: '/tmp/synthetic-parent-home',
      XDG_DATA_HOME: resolve(fixture.home, 'data'),
      DBUS_SESSION_BUS_ADDRESS: fixture.bus,
    },
    { ...userInfo(), homedir: fixture.home },
  );
  try {
    const before = await fingerprintHost(resources);
    expect(Object.keys(resources)).toEqual(['directories']);
    expect(Object.keys(before)).toEqual(['directories']);
    expect(await fingerprintDirectory(fixture.keyrings)).toBe('absent');
    assertHostUnchanged(before, await fingerprintHost(resources));
    // The control proves activation is enabled on this genuine D-Bus fixture.
    await fixture.control([
      '--user',
      '--timeout=1s',
      'get-property',
      'org.freedesktop.secrets',
      '/org/freedesktop/secrets',
      'org.freedesktop.Secret.Service',
      'Collections',
    ]);
    expect(Array.isArray(await fingerprintDirectory(fixture.keyrings))).toBe(
      true,
    );
    const after = await fingerprintHost(resources);
    expect(() => assertHostUnchanged(before, after)).toThrow('"." added');
  } finally {
    await fixture.close();
  }
});

it('a missing activation fixture daemon removes its temporary HOME', async () => {
  const home = await temporaryTestHome();
  const factory = vi
    .spyOn(environmentSupport, 'temporaryTestHome')
    .mockResolvedValueOnce(home);
  try {
    await expect(
      activationBus(resolve(home, 'missing-dbus-daemon')),
    ).rejects.toThrow('ENOENT');
    expect(await fingerprintDirectory(home)).toBe('absent');
  } finally {
    factory.mockRestore();
    await rm(home, { recursive: true, force: true });
  }
});

it('fresh child environments reject unallowlisted values and owner directory or bus overrides', async () => {
  const home = await temporaryTestHome();
  vi.stubEnv('NOOK_LEAK_SENTINEL', 'synthetic-only');
  vi.stubEnv('NODE_OPTIONS', '--import=/tmp/parent-only.mjs');
  vi.stubEnv('LC_CTYPE', 'C');
  try {
    const env = testEnvironment(home);
    expect(env.NOOK_LEAK_SENTINEL).toBeUndefined();
    expect(env.NODE_OPTIONS).toBeUndefined();
    expect(env.LC_CTYPE).toBe('C');
    expect(env.HOME).toBe(home);
    expect(env.DBUS_SESSION_BUS_ADDRESS).toBe(unavailableSessionBus(home));
    for (const override of [
      { HOME: '/tmp/owner' },
      { XDG_DATA_HOME: '/tmp/owner/data' },
      { DBUS_SESSION_BUS_ADDRESS: 'unix:path=/tmp/owner/bus' },
      { NOOK_LEAK_SENTINEL: 'synthetic-only' },
    ])
      expect(() => testEnvironment(home, override)).toThrow();
    expect(() =>
      testEnvironment(home, {}, 'unix:path=/tmp/owner/bus,guid=abcdef'),
    ).toThrow('private session bus');
    for (const invalidHome of [undefined, 'relative'])
      expect(() => testEnvironment(invalidHome)).toThrow(
        'temporary absolute HOME',
      );
    expect(() => testEnvironment(userInfo().homedir)).toThrow('owner HOME');
    expect(
      testEnvironment(home, {
        XDG_CONFIG_HOME: '',
        NODE_OPTIONS: '--import=/tmp/synthetic.mjs',
        NOOK_TEST_OPEN_STATUS: undefined,
      }).XDG_CONFIG_HOME,
    ).toBe('');
    expect(
      testEnvironment(home, { XDG_CONFIG_HOME: 'relative' }).XDG_CONFIG_HOME,
    ).toBe('relative');
    expect(() => testEnvironment(home, { XDG_RUNTIME_DIR: undefined })).toThrow(
      'temporary HOME',
    );
  } finally {
    vi.unstubAllEnvs();
    await rm(home, { recursive: true, force: true });
  }
});

it('the global setup teardown fails on fake owner writes and restores the test runner environment', async () => {
  const ownerHome = await temporaryTestHome();
  const directory = resolve(ownerHome, '.local/share/keyrings');
  const originalHome = process.env.HOME;
  const isolation = await startHostIsolation({ directories: [directory] });
  const runnerHome = process.env.HOME;
  if (runnerHome === undefined)
    throw new Error('The isolated runner needs HOME.');
  try {
    expect(runnerHome === originalHome).toBe(false);
    expect(process.env.DBUS_SESSION_BUS_ADDRESS).toBe(
      unavailableSessionBus(runnerHome),
    );
    await mkdir(directory, { recursive: true });
    await writeFile(resolve(directory, 'synthetic-item'), 'synthetic-only');
    await expect(isolation.close()).rejects.toThrow(
      'Host isolation failed: owner keyring directory changed',
    );
    expect(process.env.HOME === originalHome).toBe(true);
    expect(await fingerprintDirectory(runnerHome)).toBe('absent');
  } finally {
    await rm(ownerHome, { recursive: true, force: true });
  }
});

const processFixture = (
  pid: number,
  changes: Partial<HostProcess> = {},
): HostProcess => ({
  pid,
  parent: 1,
  started: String(pid),
  name: 'node',
  home: '/tmp/unrelated-home',
  run: '',
  ...changes,
});
it('orphan detection preserves existing owner daemons and catches adopted and descendant test daemons', () => {
  const owner = processFixture(10, { name: 'gnome-keyring-d' });
  const root = processFixture(20);
  const adopted = processFixture(30, {
    home: '/tmp/nook-cli-synthetic-run-orphan',
  });
  const tagged = processFixture(40, {
    name: 'gnome-keyring-d',
    run: 'synthetic-run',
  });
  const child = processFixture(50, { parent: 20 });
  const daemon = processFixture(60, { name: 'dbus-daemon', parent: 50 });
  const unrelated = processFixture(70, { name: 'dbus-daemon' });
  const cycle = processFixture(80, { name: 'dbus-daemon', parent: 80 });
  const result = orphanedProcesses(
    [owner],
    [owner, root, adopted, tagged, child, daemon, unrelated, cycle],
    { id: 'synthetic-run', pid: 20, home: '/tmp/nook-test-run-synthetic' },
  );
  expect(result.map((item) => item.pid)).toEqual([30, 40, 60]);
  const parentFixture = processFixture(90, {
    home: '/tmp/nook-cli-parent',
    run: 'parent-run',
  });
  const childAdopted = {
    ...adopted,
    home: '/tmp/nook-cli-child-run-orphan',
  };
  expect(
    orphanedProcesses([], [parentFixture, childAdopted], {
      id: 'child-run',
      pid: 20,
      home: '/tmp/nook-test-run-child',
    }).map((item) => item.pid),
  ).toEqual([30]);
});

it('nested isolation cleanup preserves the workerd runtime and private bus of an active parent test', async () => {
  const owner = await temporaryTestHome();
  const app = await runtime();
  const keyring = await privateKeyring();
  try {
    const isolation = await startHostIsolation({
      directories: [resolve(owner, 'data/keyrings')],
    });
    await isolation.close();
    const response = await fetch(`${app.origin}/api/whoami`);
    const body = await response.json();
    expect(response.status).toBe(401);
    expect(body).toEqual({ _tag: 'Unauthorized' });
    expect(
      await keyring.store('http://synthetic.nook.test', 'synthetic-only'),
    ).toBe(0);
  } finally {
    await keyring.close();
    await app.close();
    await rm(owner, { recursive: true, force: true });
  }
});

it('the tripwire kills a real orphan and fails the run with only its PID', async () => {
  const id = process.env.NOOK_TEST_RUN;
  if (!id) throw new Error('The isolated runner needs a run identity.');
  const home = await temporaryTestHome(`/tmp/nook-cli-${id}-orphan-`);
  const before = await snapshotProcesses();
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    env: testEnvironment(home),
    stdio: 'ignore',
  });
  const closed = once(child, 'exit');
  const pid = child.pid;
  if (pid === undefined) throw new Error('Synthetic child did not start.');
  try {
    const info = await readHostProcess(pid);
    expect(info?.home).toBe(home);
    const orphans = orphanedProcesses(before, await snapshotProcesses(), {
      id,
      pid: process.pid,
      home,
    });
    expect(orphans.some((item) => item.pid === child.pid)).toBe(true);
    const messages = await killOrphans(
      orphans.filter((item) => item.pid === child.pid),
    );
    const fingerprint = { directories: {} };
    expect(() =>
      assertHostUnchanged(fingerprint, fingerprint, messages),
    ).toThrow(`orphaned test process PID ${child.pid} terminated`);
    await closed;
    expect(await readHostProcess(pid)).toBeUndefined();
  } finally {
    child.kill('SIGKILL');
    await rm(home, { recursive: true, force: true });
  }
});

it('orphan cleanup never kills a reused PID and reports failed termination', async () => {
  const orphan = processFixture(999999);
  const kill = vi.fn(() => true as const);
  expect(await killOrphans([orphan], async () => undefined, kill)).toEqual([]);
  expect(
    await killOrphans(
      [orphan],
      async () => ({ ...orphan, started: 'new-process' }),
      kill,
    ),
  ).toEqual([]);
  expect(kill).not.toHaveBeenCalled();
  const messages = await killOrphans(
    [orphan],
    async () => orphan,
    () => {
      throw new Error('synthetic-private-error');
    },
  );
  expect(messages).toEqual([
    'orphaned test process PID 999999 could not be terminated',
  ]);
});
