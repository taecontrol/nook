import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { userInfo } from 'node:os';
import { dirname, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  readHostProcess,
  snapshotProcesses,
} from '../scripts/lib/host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
  ownerResources,
} from '../scripts/lib/host-resources.ts';
import { evidenceRoot } from '../scripts/lib/instrument.ts';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';
import { activationBus } from './support/activation-bus.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import { launchSandbox } from './support/sandbox.ts';
import type { Probe } from './support/sandbox-probe.ts';

async function realOwnerProbe(
  fixture: PrivateKeyring,
  mode: Probe['mode'],
): Promise<Probe> {
  const owner = userInfo();
  const directories = ownerResources(process.env).directories;
  return {
    owner: {
      home: owner.homedir,
      uid: owner.uid,
      data: resolve(owner.homedir, '.local/share'),
      directories,
    },
    binds: [
      '/usr',
      '/etc',
      dirname(dirname(await realpath(process.execPath))),
      process.cwd(),
      fixture.home,
      ...(process.env.COVERAGE_RUN ? [evidenceRoot] : []),
    ],
    mode,
  };
}

async function probe(fixture: PrivateKeyring, input: Probe) {
  const hook = resolve(fixture.home, 'probe.mjs');
  await writeFile(
    hook,
    `import { probeSandbox } from ${JSON.stringify(resolve('tests/support/sandbox-probe.ts'))};\nawait probeSandbox(${JSON.stringify(input)});\n`,
  );
  const result = await fixture.start(['--help'], {
    NODE_OPTIONS: `--import=${hook}`,
  }).done;
  return { status: result.status, report: JSON.parse(result.stdout) };
}

it('E1/E13: a guarded fixture child cannot use owner paths or read an unbound host sentinel', async () => {
  const sentinelHome = await mkdtemp('/tmp/nook-sentinel-');
  const sentinel = resolve(sentinelHome, 'sentinel');
  const bytes = Buffer.from('synthetic sentinel must remain byte-identical');
  let fixture: PrivateKeyring | undefined;
  try {
    await writeFile(sentinel, bytes);
    fixture = await privateKeyring();
    const input = await realOwnerProbe(fixture, 'escape');
    const before = await fingerprintHost({
      directories: input.owner.directories,
    });
    input.sentinel = sentinel;
    input.marker = `sandbox-${crypto.randomUUID()}`;
    const result = await probe(fixture, input);
    expect(
      result.report.gate,
      'Stat gate must pass before any write or D-Bus connection',
    ).toBe(true);
    expect(result.status).toBe(0);
    expect(result.report.store).not.toBe(0);
    expect(result.report.lookup).not.toBe(0);
    expect(result.report.wrote).toBe(true);
    expect(result.report.sentinelReadable).toBe(false);
    assertHostUnchanged(
      before,
      await fingerprintHost({ directories: input.owner.directories }),
    );
    expect((await readFile(sentinel)).equals(bytes)).toBe(true);
  } finally {
    await fixture?.close();
    await rm(sentinelHome, { recursive: true, force: true });
  }
});

it.each(['keyrings', 'nook', 'bus', 'unexpected-entry'])(
  'E2/E13: the stat-only gate rejects a visible synthetic owner %s before writes or connections',
  async (entry) => {
    const fixture = await privateKeyring();
    const home = resolve(fixture.home, 'synthetic-owner');
    const data = resolve(home, '.local/share');
    const directories = [
      resolve(data, 'keyrings'),
      resolve(home, '.config/nook'),
    ];
    const paths = {
      keyrings: directories[0],
      nook: directories[1],
      bus: resolve(home, 'bus'),
      'unexpected-entry': resolve(data, 'unexpected'),
    };
    try {
      await mkdir(data, { recursive: true });
      await mkdir(dirname(paths[entry as keyof typeof paths]), {
        recursive: true,
      });
      await writeFile(paths[entry as keyof typeof paths], 'synthetic-only');
      const resources = { directories: [home] };
      const before = await fingerprintHost(resources);
      const result = await probe(fixture, {
        owner: {
          home,
          data,
          uid: userInfo().uid,
          directories: [...directories, resolve(home, 'bus')],
        },
        binds: [],
        mode: 'escape',
        sentinel: paths[entry as keyof typeof paths],
        marker: 'must-never-be-created',
      });
      expect(result.status).toBe(3);
      expect(result.report).toEqual({ gate: false });
      expect(await fingerprintHost(resources)).toEqual(before);
    } finally {
      await fixture.close();
    }
  },
);

it('E3: owner HOME has only mount parents and run and tmp contain only their allowlisted empty trees', async () => {
  const fixture = await privateKeyring('absent');
  try {
    const input = await realOwnerProbe(fixture, 'empty');
    expect((await probe(fixture, input)).report.gate).toBe(true);
    const hook = resolve(fixture.home, 'empty.mjs');
    await writeFile(
      hook,
      `import { readdirSync, statSync } from 'node:fs';\nconsole.log(JSON.stringify({run:readdirSync('/run'), users:readdirSync('/run/user'), user:readdirSync('/run/user/${input.owner.uid}'), tmp:readdirSync('/tmp'), absent:['/root','/var','/srv','/media','/mnt'].map(p=>{try{statSync(p);return false}catch(e){return e.code==='ENOENT'}})}));process.exit(0);`,
    );
    const result = await fixture.start(['--help'], {
      NODE_OPTIONS: `--import=${hook}`,
    }).done;
    expect(result.status).toBe(0);
    const report = JSON.parse(result.stdout);
    expect(report.run).toEqual(['user']);
    expect(report.users).toEqual([String(input.owner.uid)]);
    expect(report.user).toEqual([]);
    expect(report.tmp).toEqual([fixture.home.slice('/tmp/'.length)]);
    expect(report.absent).toEqual([true, true, true, true, true]);
  } finally {
    await fixture.close();
  }
});

it('E4: repository, build, and non-coverage evidence writes fail read-only without changing host files', async () => {
  const fixture = await privateKeyring('absent');
  const name = `sandbox-${crypto.randomUUID()}`;
  const files = [
    resolve(name),
    resolve('.local/test-build', name),
    resolve(evidenceRoot, name),
  ];
  try {
    for (const file of files) {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, 'synthetic-original');
    }
    const input = await realOwnerProbe(fixture, 'readonly');
    input.files = files.flatMap((file) => [file, `${file}-new`]);
    const result = await probe(fixture, input);
    expect(result.report.gate).toBe(true);
    expect(result.report.errors).toEqual([
      'EROFS',
      'EROFS',
      'EROFS',
      'EROFS',
      ...(process.env.COVERAGE_RUN
        ? ['writable', 'writable']
        : ['EROFS', 'EROFS']),
    ]);
    for (const file of files.slice(0, process.env.COVERAGE_RUN ? 2 : 3))
      expect(await readFile(file, 'utf8')).toBe('synthetic-original');
  } finally {
    await fixture.close();
    for (const file of files.flatMap((file) => [file, `${file}-new`]))
      await rm(file, { force: true });
  }
});

async function namespaces(pid: number | 'self') {
  return {
    user: await readlink(`/proc/${pid}/ns/user`),
    pid: await readlink(`/proc/${pid}/ns/pid`),
    ipc: await readlink(`/proc/${pid}/ns/ipc`),
  };
}

function isolated(
  actual: Awaited<ReturnType<typeof namespaces>>,
  parent: Awaited<ReturnType<typeof namespaces>>,
) {
  expect(actual.user).not.toBe(parent.user);
  expect(actual.pid).not.toBe(parent.pid);
  expect(actual.ipc).not.toBe(parent.ipc);
}

it('E5/E6: the CLI, daemons, secret-tool shim, and dbus-send use isolated user, PID, and IPC namespaces', async () => {
  const parent = await namespaces('self');
  const fixture = await privateKeyring();
  try {
    for (const name of ['secret-tool', 'dbus-send'])
      await writeFile(
        resolve(fixture.shim, name),
        `#!/bin/sh\n/usr/bin/readlink /proc/self/ns/user /proc/self/ns/pid /proc/self/ns/ipc > "$HOME/${name}-namespaces"\nexec /usr/bin/${name} "$@"\n`,
        { mode: 0o700 },
      );
    const hook = resolve(fixture.home, 'namespaces.mjs');
    await writeFile(
      hook,
      `import {readlinkSync,writeFileSync} from 'node:fs';writeFileSync(process.env.HOME+'/cli-namespaces',JSON.stringify({user:readlinkSync('/proc/self/ns/user'),pid:readlinkSync('/proc/self/ns/pid'),ipc:readlinkSync('/proc/self/ns/ipc')}));`,
    );
    await fixture.start(['login', 'http://127.0.0.1:1'], {
      NODE_OPTIONS: `--import=${hook}`,
    }).done;
    isolated(
      JSON.parse(
        await readFile(resolve(fixture.home, 'cli-namespaces'), 'utf8'),
      ),
      parent,
    );
    for (const name of ['secret-tool', 'dbus-send']) {
      const [user, pid, ipc] = (
        await readFile(resolve(fixture.home, `${name}-namespaces`), 'utf8')
      )
        .trim()
        .split('\n');
      isolated({ user, pid, ipc }, parent);
    }
    const processes = (await snapshotProcesses()).filter(
      (item) => item.home === fixture.home,
    );
    for (const name of ['gnome-keyring-d', 'dbus-daemon']) {
      const daemon = processes.find((item) => item.name === name);
      expect(daemon !== undefined).toBe(true);
      if (!daemon) throw new Error('Fixture daemon is missing.');
      isolated(await namespaces(daemon.pid), parent);
    }
  } finally {
    await fixture.close();
  }
});

it.each(['normal', 'force-killed'])(
  'E9: closing a %s fixture leaves no bus, keyring, or CLI process',
  async (mode) => {
    const fixture = await privateKeyring();
    const hook = resolve(fixture.home, 'live.mjs');
    try {
      await writeFile(
        hook,
        `import {writeFileSync} from 'node:fs';writeFileSync(process.env.HOME+'/live','ready');setInterval(()=>{},1000);await new Promise(()=>{});`,
      );
      fixture.start(['--help'], { NODE_OPTIONS: `--import=${hook}` });
      await expect
        .poll(async () => {
          try {
            return await readFile(resolve(fixture.home, 'live'), 'utf8');
          } catch {
            return '';
          }
        })
        .toBe('ready');
      const processes = (await snapshotProcesses()).filter(
        (item) => item.home === fixture.home,
      );
      expect(processes.some((item) => item.name === 'gnome-keyring-d')).toBe(
        true,
      );
      expect(processes.some((item) => item.name === 'dbus-daemon')).toBe(true);
      if (mode === 'force-killed') {
        const host = processes.find((item) => item.parent === process.pid);
        expect(host !== undefined).toBe(true);
        if (!host) throw new Error('Fixture host is missing.');
        process.kill(-host.pid, 'SIGKILL');
      }
      await fixture.close();
      for (const item of processes)
        await expect
          .poll(
            async () =>
              (await readHostProcess(item.pid))?.home === fixture.home,
          )
          .toBe(false);
    } finally {
      await fixture.close();
    }
  },
);

it.each(['missing', 'uid-map-denied'])(
  'E10: %s bubblewrap fails actionably and removes the fixture HOME without an unsandboxed fallback',
  async (failure) => {
    const root = await temporaryTestHome('/tmp/nook-sandbox-failure-');
    const bin = resolve(root, 'config');
    const fixtures = resolve(root, 'fixtures');
    await mkdir(fixtures);
    try {
      if (failure === 'uid-map-denied')
        await writeFile(
          resolve(bin, 'bwrap'),
          '#!/bin/sh\necho "bwrap: setting up uid map: Permission denied" >&2\nexit 1\n',
          { mode: 0o700 },
        );
      const setup = privateKeyring as (
        service: 'present',
        options: { tempRoot: string; sandboxExecutable: string },
      ) => Promise<PrivateKeyring>;
      await expect(
        setup('present', {
          tempRoot: fixtures,
          sandboxExecutable: resolve(
            bin,
            failure === 'missing' ? 'missing-bwrap' : 'bwrap',
          ),
        }).then(async (fixture) => {
          await fixture.close();
          return fixture;
        }),
      ).rejects.toThrow(
        failure === 'missing'
          ? /bubblewrap.*required/i
          : /nook-bwrap.*sudo apparmor_parser -r/,
      );
      expect(await readdir(fixtures)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('E5/E11: activation daemon and genuine busctl control are sandboxed and activate only the bound fixture', async () => {
  const parent = await namespaces('self');
  const fixture = await activationBus();
  try {
    const daemon = (await snapshotProcesses()).find(
      (item) => item.home === fixture.home && item.name === 'dbus-daemon',
    );
    expect(daemon !== undefined).toBe(true);
    if (!daemon) throw new Error('Fixture daemon is missing.');
    isolated(await namespaces(daemon.pid), parent);
    const hook = resolve(fixture.home, 'busctl');
    await writeFile(
      hook,
      '#!/bin/sh\n/usr/bin/readlink /proc/self/ns/user /proc/self/ns/pid /proc/self/ns/ipc > "$HOME/control-namespaces"\nexec /usr/bin/busctl "$@"\n',
      { mode: 0o700 },
    );
    const control = fixture as typeof fixture & {
      control(args: string[], executable?: string): Promise<unknown>;
    };
    await control.control(
      [
        '--user',
        '--timeout=1s',
        'get-property',
        'org.freedesktop.secrets',
        '/org/freedesktop/secrets',
        'org.freedesktop.Secret.Service',
        'Collections',
      ],
      hook,
    );
    const [user, pid, ipc] = (
      await readFile(resolve(fixture.home, 'control-namespaces'), 'utf8')
    )
      .trim()
      .split('\n');
    isolated({ user, pid, ipc }, parent);
    expect(await readdir(resolve(fixture.home, 'data'))).toContain('keyrings');
  } finally {
    await fixture.close();
  }
});

it('E6: the shared sandbox sets exactly the allowlisted child environment', async () => {
  const home = await temporaryTestHome('/tmp/nook-sandbox-env-');
  const env = testEnvironment(home);
  const child = launchSandbox(home, env, process.execPath, [
    '-e',
    'console.log(JSON.stringify(process.env))',
  ]);
  let output = '';
  child.child.stdout.on('data', (chunk) => {
    output += chunk;
  });
  child.child.stdin.end();
  try {
    expect(await child.closed).toBe(0);
    expect(JSON.parse(output)).toEqual(env);
  } finally {
    await child.close();
    await rm(home, { recursive: true, force: true });
  }
});

it('E8: a fixture beneath the read-only repository stays writable at its host path', async () => {
  const root = await mkdtemp(resolve('.local/n-'));
  let fixture: PrivateKeyring | undefined;
  try {
    fixture = await privateKeyring('present', { tempRoot: root });
    const hook = resolve(fixture.home, 'write.mjs');
    await writeFile(
      hook,
      "import {writeFileSync} from 'node:fs';writeFileSync(process.env.HOME+'/written','synthetic-only');",
    );
    expect(
      (
        await fixture.start(['--help'], { NODE_OPTIONS: `--import=${hook}` })
          .done
      ).status,
    ).toBe(0);
    expect(await readFile(resolve(fixture.home, 'written'), 'utf8')).toBe(
      'synthetic-only',
    );
    expect(await readdir(resolve(fixture.home, 'data/keyrings'))).toContain(
      'login.keyring',
    );
    await fixture.close();
    expect(await readdir(root)).toEqual([]);
  } finally {
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  }
});

it('E4: the real CLI writes execution evidence only during a coverage run', async () => {
  const fixture = await privateKeyring('absent');
  const evidence = resolve(
    evidenceRoot,
    `cli-sandbox-${crypto.randomUUID()}.json`,
  );
  try {
    const result = await fixture.start(['--help'], {
      NOOK_CLI_COVERAGE: evidence,
    }).done;
    expect(result.status).toBe(0);
    if (process.env.COVERAGE_RUN) {
      const observed = JSON.parse(await readFile(evidence, 'utf8'));
      expect(observed.seam).toBe('cli');
      expect(Object.keys(observed.loaded).length).toBeGreaterThan(0);
    } else {
      await expect(readFile(evidence)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  } finally {
    await fixture.close();
    await rm(evidence, { force: true });
  }
});

async function syntheticMountExecutable(
  root: string,
  source: string,
  target: string,
) {
  const executable = resolve(root, 'bwrap.mjs');
  await writeFile(
    executable,
    `#!${process.execPath}\nimport {spawnSync} from 'node:child_process';\nconst args=process.argv.slice(2);args.splice(args.indexOf('--'),0,'--ro-bind',${JSON.stringify(source)},${JSON.stringify(target)});const result=spawnSync('/usr/bin/bwrap',args,{stdio:'inherit',env:process.env});process.exit(result.status??1);\n`,
    { mode: 0o700 },
  );
  return executable;
}

it.each(['keyrings', 'nook', 'bus', 'unexpected-entry'] as const)(
  'E2/E13: an independently visible synthetic %s fails the stat-only gate',
  async (entry) => {
    const root = await temporaryTestHome('/tmp/nook-guard-');
    const source = resolve(root, 'source');
    const sentinel = resolve(root, 'sentinel');
    const owner = {
      home: `/tmp/nook-visible-owner-${crypto.randomUUID()}`,
      uid: userInfo().uid,
      data: '',
      directories: [] as string[],
    };
    owner.data = resolve(owner.home, '.local/share');
    owner.directories = [
      resolve(owner.data, 'keyrings'),
      resolve(owner.home, '.config/nook'),
    ];
    const target =
      entry === 'bus'
        ? `/run/user/${owner.uid}/bus`
        : entry === 'keyrings'
          ? owner.directories[0]
          : entry === 'nook'
            ? owner.directories[1]
            : resolve(owner.data, 'unexpected');
    let fixture: PrivateKeyring | undefined;
    try {
      await mkdir(source);
      await writeFile(resolve(source, 'synthetic-entry'), 'synthetic-only');
      await writeFile(sentinel, 'synthetic-only');
      const executable = await syntheticMountExecutable(root, source, target);
      const before = await fingerprintHost({ directories: [source] });
      fixture = await privateKeyring('absent', {
        sandboxExecutable: executable,
      });
      const result = await probe(fixture, {
        owner,
        binds: entry === 'unexpected-entry' ? [] : [target],
        mode: 'empty',
        sentinel,
        marker: 'must-never-be-created',
      });
      expect(result.status).toBe(3);
      expect(result.report).toEqual({ gate: false });
      expect(await fingerprintHost({ directories: [source] })).toEqual(before);
    } finally {
      await fixture?.close();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('E9: killing the sandbox launcher parent leaves no owned process', async () => {
  const { spawn } = await import('node:child_process');
  const { killOrphans } = await import('../scripts/lib/host-processes.ts');
  const home = await temporaryTestHome('/tmp/nook-cli-parentdeath-');
  const parent = spawn(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `import {launchSandbox} from ${JSON.stringify(resolve('tests/support/sandbox.ts'))};\nconst sandbox=launchSandbox(${JSON.stringify(home)},process.env,process.execPath,['-e',${JSON.stringify("require('node:fs').writeFileSync(process.env.HOME+'/live','ready');setInterval(()=>{},1000)")}]);sandbox.child.stdout.resume();setInterval(()=>{},1000);`,
    ],
    { env: testEnvironment(home), stdio: 'ignore' },
  );
  try {
    await expect
      .poll(async () => {
        try {
          return await readFile(resolve(home, 'live'), 'utf8');
        } catch {
          return '';
        }
      })
      .toBe('ready');
    parent.kill('SIGKILL');
    await expect
      .poll(
        async () =>
          (await snapshotProcesses()).filter((item) => item.home === home)
            .length,
      )
      .toBe(0);
  } finally {
    parent.kill('SIGKILL');
    await killOrphans(
      (await snapshotProcesses()).filter((item) => item.home === home),
    );
    await rm(home, { recursive: true, force: true });
  }
});

it('E11: a stalled synthetic activation control is terminated by the fixture deadline', async () => {
  const fixture = await activationBus();
  const hook = resolve(fixture.home, 'stalled-control');
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await writeFile(hook, '#!/bin/sh\nexec /usr/bin/sleep 10\n', {
      mode: 0o700,
    });
    const deadline = new Promise<string>((resolveDeadline) => {
      timeout = setTimeout(() => resolveDeadline('timed-out'), 3000);
    });
    expect(await Promise.race([fixture.control([], hook), deadline])).not.toBe(
      'timed-out',
    );
  } finally {
    clearTimeout(timeout);
    await fixture.close();
  }
});

it('E2/E13: a disk-backed synthetic owner cannot pass the tmpfs metadata gate', async () => {
  const root = await mkdtemp(resolve('.local/t-'));
  const source = resolve(root, 'source');
  const home = `/tmp/nook-visible-owner-${crypto.randomUUID()}`;
  let fixture: PrivateKeyring | undefined;
  try {
    await mkdir(source);
    // On btrfs, one 20-character name gives this directory the same size as
    // an empty tmpfs directory. The filesystem type must distinguish them.
    // https://github.com/torvalds/linux/blob/master/fs/btrfs/inode.c
    await mkdir(resolve(source, 'synthetic-parent-dir'));
    const executable = await syntheticMountExecutable(root, source, home);
    const before = await fingerprintHost({ directories: [source] });
    fixture = await privateKeyring('absent', { sandboxExecutable: executable });
    const result = await probe(fixture, {
      owner: {
        home,
        uid: userInfo().uid,
        data: home,
        directories: [
          resolve(home, 'keyrings'),
          resolve(home, '.local/share/keyrings'),
          resolve(home, '.config/nook'),
        ],
      },
      binds: [home],
      mode: 'empty',
    });
    expect(result.status).toBe(3);
    expect(result.report).toEqual({ gate: false });
    expect(await fingerprintHost({ directories: [source] })).toEqual(before);
  } finally {
    await fixture?.close();
    await rm(root, { recursive: true, force: true });
  }
});
