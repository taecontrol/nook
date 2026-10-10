import { rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { startHostIsolation } from '../scripts/lib/host-isolation.ts';
import {
  type HostProcess,
  readHostProcess,
  snapshotProcesses,
} from '../scripts/lib/host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
} from '../scripts/lib/host-resources.ts';
import { temporaryTestHome } from '../scripts/lib/test-environment.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';

it.runIf(process.platform === 'linux')(
  'nested teardown preserves a late untagged daemon launched by the parent fixture',
  async () => {
    const home = await temporaryTestHome('/tmp/nook-parent-');
    const resources = {
      directories: [resolve(home, 'synthetic-owner/keyrings')],
    };
    const before = await fingerprintHost(resources);
    const parentRun = process.env.NOOK_TEST_RUN;
    const parent = await privateKeyring('absent');
    let isolation: Awaited<ReturnType<typeof startHostIsolation>> | undefined;
    let command: ReturnType<PrivateKeyring['command']> | undefined;
    let closed = false;
    try {
      const baseline = new Set(
        (await snapshotProcesses()).map(
          (item) => `${item.pid}:${item.started}`,
        ),
      );
      isolation = await startHostIsolation(resources);
      expect(isolation.env.NOOK_TEST_RUN).not.toBe(parentRun);
      command = parent.command(
        '/usr/bin/dbus-daemon',
        [
          '--session',
          '--nofork',
          '--print-address=1',
          `--address=unix:path=${resolve(parent.home, 'late-bus')}`,
        ],
        { NOOK_TEST_RUN: undefined },
      );
      await expect.poll(() => command?.output().startsWith('unix:')).toBe(true);
      let daemon: HostProcess | undefined;
      await expect
        .poll(async () => {
          daemon = (await snapshotProcesses()).find(
            (item) =>
              item.name === 'dbus-daemon' &&
              item.home === parent.home &&
              item.run === '' &&
              !baseline.has(`${item.pid}:${item.started}`),
          );
          return daemon !== undefined;
        })
        .toBe(true);
      if (!daemon) throw new Error('The late parent daemon did not start.');
      const identity = daemon;
      expect(await readHostProcess(identity.pid)).toMatchObject({
        started: identity.started,
        home: parent.home,
        run: '',
      });
      try {
        await expect(isolation.close()).resolves.toBeUndefined();
      } finally {
        closed = true;
      }
      expect(await readHostProcess(identity.pid)).toMatchObject({
        started: identity.started,
        home: parent.home,
        run: '',
      });
      expect(
        await parent.command(process.execPath, [
          '-e',
          "process.stdout.write('parent-fixture-survived')",
        ]).done,
      ).toMatchObject({ status: 0, stdout: 'parent-fixture-survived' });
      assertHostUnchanged(before, await fingerprintHost(resources));
    } finally {
      if (isolation && !closed) await isolation.close().catch(() => {});
      if (command) {
        await command.kill('SIGTERM');
        await command.done;
      }
      await parent.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
