import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { expect } from 'vitest';
import { evidenceRoot } from '../../scripts/lib/instrument.ts';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';
import { type CommandResult, privateMacKeychain } from './macos-keychain.ts';
import { testBuild } from './runtime.ts';
import { launchSandbox } from './sandbox.ts';

export async function privateKeyring(
  service: 'present' | 'absent' = 'present',
  options: {
    nodeOptions?: string;
    tempRoot?: string;
    sandboxExecutable?: string;
  } = {},
) {
  if (process.platform === 'darwin') {
    const keychain = await privateMacKeychain(options);
    if (service === 'absent')
      await writeFile(
        resolve(keychain.shim, 'security'),
        '#!/bin/sh\nexit 2\n',
        { mode: 0o700 },
      );
    return keychain;
  }
  const run = process.env.NOOK_TEST_RUN;
  if (!run)
    throw new Error(
      'Linux CLI fixtures require an isolated test run identity.',
    );
  const home = await mkdtemp(
    resolve(options.tempRoot ?? '/tmp', `nook-cli-${run}-`),
  );
  let sandbox: ReturnType<typeof launchSandbox> | undefined;
  try {
    const shim = resolve(home, 'bin');
    for (const path of ['bin', 'config', 'data', 'state', 'cache', 'runtime'])
      await mkdir(resolve(home, path), { mode: 0o700 });
    await writeFile(
      resolve(shim, 'secret-tool'),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/argv"\nexec /usr/bin/secret-tool "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      resolve(shim, 'dbus-send'),
      '#!/bin/sh\nexec /usr/bin/dbus-send "$@"\n',
      { mode: 0o700 },
    );
    await writeFile(
      resolve(shim, 'xdg-open'),
      '#!/bin/sh\nprintf "%s\\n" "$@" >> "$HOME/opened"\nexit "${NOOK_TEST_OPEN_STATUS:-0}"\n',
      { mode: 0o700 },
    );
    const env = testEnvironment(home, {
      NOOK_TEST_SERVICE: service,
      NODE_OPTIONS: options.nodeOptions,
    });
    const busConfig = resolve(home, 'bus.conf');
    await writeFile(
      busConfig,
      `<busconfig><type>session</type><listen>unix:path=${encodeURIComponent(resolve(home, 'bus'))}</listen><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
    );
    sandbox = launchSandbox(
      home,
      env,
      '/usr/bin/dbus-run-session',
      [
        `--config-file=${busConfig}`,
        '--',
        process.execPath,
        resolve('tests/support/keyring-host.ts'),
      ],
      options.sandboxExecutable,
    );
    const started = sandbox;
    const host = started.child;
    async function stopHost() {
      try {
        await started.close();
      } finally {
        await rm(home, { recursive: true, force: true });
      }
    }
    let id = 0;
    const signals = new Map<number, (delivered: boolean) => void>();
    const running = new Map<
      number,
      {
        stdout: string;
        stderr: string;
        finish: (value: CommandResult) => void;
      }
    >();
    let readyResolve: (bus: string) => void;
    let readyReject: (error: Error) => void;
    const ready = new Promise<string>((resolveReady, reject) => {
      readyResolve = resolveReady;
      readyReject = reject;
    });
    const lines = createInterface({ input: host.stdout });
    lines.on('line', (line) => {
      const message = JSON.parse(line);
      if (message.ready) return readyResolve(message.bus);
      if (message.signalId !== undefined) {
        signals.get(message.signalId)?.(message.delivered === true);
        signals.delete(message.signalId);
        return;
      }
      const state = running.get(message.id);
      if (!state) return;
      if (message.stream === 'stdout') state.stdout += message.data;
      if (message.stream === 'stderr') state.stderr += message.data;
      if (message.status !== undefined) {
        running.delete(message.id);
        state.finish({
          ...state,
          status: message.status,
          ...(message.signal ? { signal: message.signal } : {}),
        });
      }
    });
    host.on('close', () => {
      for (const accept of signals.values()) accept(false);
      signals.clear();
      readyReject(started.failure('Private bus setup failed.'));
      for (const state of running.values())
        state.finish({ ...state, status: 1 });
      running.clear();
    });
    host.on('error', () =>
      readyReject(started.failure('Private bus could not start.')),
    );
    let bus: string;
    try {
      bus = await ready;
    } catch (error) {
      await stopHost();
      throw error;
    }
    expect(bus.startsWith('unix:'), 'Private bus address required').toBe(true);
    expect(
      bus === process.env.DBUS_SESSION_BUS_ADDRESS,
      'Never use the owner session bus',
    ).toBe(false);
    function start(
      file: string,
      args: string[],
      extra: Record<string, string | undefined> = {},
      input = '',
      workingDirectory = process.cwd(),
    ) {
      if (
        Object.keys(extra).some(
          (key) => key.startsWith('DBUS_') || key === 'GNOME_KEYRING_CONTROL',
        )
      )
        throw new Error('Private bus overrides are forbidden.');
      testEnvironment(home, extra, bus);
      const current = ++id;
      let finish: (value: CommandResult) => void;
      const done = new Promise<CommandResult>((accept) => {
        finish = accept;
      });
      const state = { stdout: '', stderr: '', finish: finish! };
      running.set(current, state);
      host.stdin.write(
        `${JSON.stringify({ id: current, file, args, input, cwd: workingDirectory, env: { PATH: `${shim}:/usr/bin`, ...extra }, unset: Object.keys(extra).filter((key) => extra[key] === undefined) })}\n`,
      );
      return {
        done,
        output: () => state.stdout + state.stderr,
        kill(signal: NodeJS.Signals = 'SIGTERM') {
          if (!host.stdin.writable) return Promise.resolve(false);
          return new Promise<boolean>((accept) => {
            const signalId = ++id;
            signals.set(signalId, accept);
            host.stdin.write(
              `${JSON.stringify({ id: current, signal, signalId })}\n`,
            );
          });
        },
      };
    }
    return {
      home,
      bus,
      shim,
      config: resolve(home, 'config/nook/config.json'),
      command: start,
      start(
        args: string[],
        extra?: Record<string, string | undefined>,
        input = '',
        workingDirectory = home,
      ) {
        expect(
          existsSync(resolve(testBuild, 'cli.js')),
          'The production Nook CLI is not implemented',
        ).toBe(true);
        return start(
          process.execPath,
          [resolve(testBuild, 'cli.js'), ...args],
          {
            ...(process.env.COVERAGE_RUN
              ? {
                  NOOK_CLI_COVERAGE: resolve(
                    evidenceRoot,
                    `cli-${crypto.randomUUID()}.json`,
                  ),
                }
              : {}),
            ...extra,
          },
          input,
          workingDirectory,
        );
      },
      lookup: async (url: string) =>
        (
          await start('/usr/bin/secret-tool', [
            'lookup',
            'service',
            'nook',
            'url',
            url,
          ]).done
        ).stdout.trim(),
      store: async (url: string, token: string) =>
        (
          await start(
            '/usr/bin/secret-tool',
            [
              'store',
              '--label=Nook synthetic test',
              'service',
              'nook',
              'url',
              url,
            ],
            {},
            token,
          ).done
        ).status,
      async close() {
        await stopHost();
      },
    };
  } catch (error) {
    await sandbox?.close();
    await rm(home, { recursive: true, force: true });
    throw error;
  }
}

export type PrivateKeyring = Awaited<ReturnType<typeof privateKeyring>>;
export async function readUserCode(login: { output: () => string }) {
  await expect
    .poll(() =>
      /\b[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\b/.test(
        login.output(),
      ),
    )
    .toBe(true);
  return /\b[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}\b/.exec(
    login.output(),
  )![0];
}
export async function filesContain(
  directory: string,
  secret: string,
): Promise<boolean> {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const path = resolve(directory, item.name);
    if (item.isDirectory() && (await filesContain(path, secret))) return true;
    if (item.isFile() && (await readFile(path)).includes(Buffer.from(secret)))
      return true;
  }
  return false;
}
