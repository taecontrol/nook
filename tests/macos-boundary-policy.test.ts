import type { ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import { Effect } from 'effect';
import { ChildProcessSpawner } from 'effect/process';
import { afterEach, expect, it, vi } from 'vitest';
import { temporaryTestHome } from '../scripts/lib/test-environment.ts';

// These are portable adapter/fault policies. Genuine Darwin syscalls and private
// keychain processes remain covered by the disposable macOS acceptance job.
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  for (const module of [
    'node:child_process',
    'node:fs/promises',
    'node:os',
    '../scripts/lib/macos-processes.ts',
  ])
    vi.doUnmock(module);
  vi.resetModules();
});

async function darwinModule<T>(load: () => Promise<T>) {
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  try {
    Object.defineProperty(process, 'platform', { value: 'darwin' });
    return await load();
  } finally {
    Object.defineProperty(process, 'platform', platform);
  }
}

it.each(['present', 'absent', 'failed'] as const)(
  'the macOS observer reports %s keychains through only allowlisted read commands',
  async (outcome) => {
    const home = await temporaryTestHome();
    const calls: { file: string; args: string[]; options: unknown }[] = [];
    vi.resetModules();
    vi.doMock('node:child_process', () => ({
      execFile: (
        file: string,
        args: string[],
        options: unknown,
        callback: (error: { code: number } | null, stdout: string) => void,
      ) => {
        calls.push({ file, args, options });
        callback(
          outcome === 'present' ? null : { code: outcome === 'absent' ? 1 : 7 },
          `  "${home}/synthetic.keychain-db"\n`,
        );
      },
    }));
    try {
      const { observeKeychains } = await import(
        '../scripts/lib/macos-keychains.ts'
      );
      if (outcome === 'failed') {
        await expect(observeKeychains(home)).rejects.toThrow(
          'Host isolation could not observe the owner keychain paths.',
        );
      } else {
        const path =
          outcome === 'present'
            ? `"${home}/synthetic.keychain-db"`
            : '<absent>';
        expect(await observeKeychains(home)).toEqual({
          searchList: path,
          defaultKeychain: path,
          loginKeychain: path,
        });
      }
      expect(calls.map((call) => call.args)).toEqual([
        ['list-keychains', '-d', 'user'],
        ['default-keychain', '-d', 'user'],
        ['login-keychain'],
      ]);
      for (const call of calls) {
        expect(call.file).toBe('/usr/bin/security');
        expect(call.options).toEqual({
          env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' },
          timeout: 5000,
          encoding: 'utf8',
        });
      }
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

it.each([
  [
    'EAGAIN',
    'Another Nook session command is in progress. Finish it before starting a new one.',
  ],
  [
    'EWOULDBLOCK',
    'Another Nook session command is in progress. Finish it before starting a new one.',
  ],
  ['EACCES', 'Could not protect the Nook session. Try again.'],
] as const)(
  'the macOS session lock translates %s into a private actionable failure',
  async (code, message) => {
    const home = await temporaryTestHome();
    const create = vi.fn(async () => {});
    const open = vi.fn(async (_path: string, _flags: number, _mode: number) => {
      throw Object.assign(new Error('Synthetic private filesystem detail'), {
        code,
      });
    });
    vi.resetModules();
    vi.doMock('node:fs/promises', () => ({ mkdir: create, open }));
    vi.doMock('node:os', () => ({ homedir: () => home }));
    try {
      const { lockSession } = await darwinModule(
        () => import('../apps/cli/src/session-lock.ts'),
      );
      const error = await Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            yield* lockSession;
          }),
        ).pipe(
          Effect.provideService(
            ChildProcessSpawner.ChildProcessSpawner,
            ChildProcessSpawner.make(() =>
              Effect.die('No process is allowed at this policy seam.'),
            ),
          ),
          Effect.catch((failure) => Effect.succeed(failure.message)),
        ),
      );
      expect(error).toBe(message);
      expect(create).toHaveBeenCalledWith(
        resolve(home, 'Library/Application Support/nook'),
        { recursive: true, mode: 0o700 },
      );
      expect(open.mock.calls[0]?.[0]).toBe(
        resolve(home, 'Library/Application Support/nook/session.lock'),
      );
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  },
);

async function processFixture() {
  const home = await temporaryTestHome();
  const directory = resolve(home, 'process-groups');
  await mkdir(directory, { mode: 0o700 });
  vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', directory);
  vi.stubEnv('NOOK_TEST_ROOT_PID', String(process.pid));
  const identity = {
    pid: 2_000_000_000,
    parent: process.pid,
    group: 2_000_000_000,
    uid: userInfo().uid,
    started: 'synthetic generation',
    name: 'node',
    home,
    run: 'synthetic-run',
  };
  return { home, directory, identity };
}

it('the macOS spawn boundary registers both argument forms, forces a private group and refuses a missing registry before launch', async () => {
  const fixture = await processFixture();
  const child = { pid: fixture.identity.pid } as ChildProcess;
  const spawn = vi.fn(() => child);
  const children = { spawn };
  vi.resetModules();
  vi.doMock('node:child_process', () => ({ default: children }));
  vi.doMock('../scripts/lib/macos-processes.ts', () => ({
    macProcessesSync: () => [fixture.identity],
  }));
  try {
    const { trackMacFixtureProcesses } = await import(
      '../scripts/lib/macos-process-groups.ts'
    );
    await darwinModule(async () => {
      trackMacFixtureProcesses();
      trackMacFixtureProcesses();
    });
    const launch =
      children.spawn as unknown as typeof import('node:child_process').spawn;
    expect(
      launch('synthetic', ['one'], { cwd: fixture.home, detached: false }),
    ).toBe(child);
    expect(launch('synthetic', { cwd: fixture.home })).toBe(child);
    expect(spawn.mock.calls).toEqual([
      ['synthetic', ['one'], { cwd: fixture.home, detached: true }],
      ['synthetic', [], { cwd: fixture.home, detached: true }],
    ]);
    const record = JSON.parse(
      await readFile(resolve(fixture.directory, `${child.pid}.json`), 'utf8'),
    );
    expect(record).toEqual({
      pid: fixture.identity.pid,
      group: fixture.identity.group,
      uid: fixture.identity.uid,
      started: fixture.identity.started,
      root: process.pid,
    });
    vi.stubEnv('NOOK_TEST_PROCESS_GROUPS', undefined);
    expect(() => launch('synthetic')).toThrow(
      'isolated process-group registry',
    );
    expect(spawn).toHaveBeenCalledTimes(2);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

it.each([false, true])(
  'failed macOS process registration only signals an unchanged captured generation (recycled=%s)',
  async (recycled) => {
    const fixture = await processFixture();
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    vi.resetModules();
    vi.doMock('../scripts/lib/macos-processes.ts', () => ({
      macProcessesSync: () => [
        {
          ...fixture.identity,
          started: recycled ? 'later generation' : fixture.identity.started,
        },
      ],
    }));
    try {
      const { recordMacProcessGroup } = await import(
        '../scripts/lib/macos-process-groups.ts'
      );
      expect(() =>
        recordMacProcessGroup(
          fixture.identity.pid,
          () => fixture.identity,
          resolve(fixture.home, 'missing-mirror'),
        ),
      ).toThrow('macOS fixture command could not register its process group.');
      if (recycled) expect(kill).not.toHaveBeenCalled();
      else
        expect(kill).toHaveBeenCalledWith(-fixture.identity.group, 'SIGKILL');
    } finally {
      await rm(fixture.home, { recursive: true, force: true });
    }
  },
);
