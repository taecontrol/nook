import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  temporaryTestHome,
  testEnvironment,
} from '../../scripts/lib/test-environment.ts';
import { launchSandbox } from './sandbox.ts';

export async function activationBus(
  executable = '/usr/bin/dbus-daemon',
  sandboxExecutable?: string,
) {
  const home = await temporaryTestHome();
  const keyrings = resolve(home, 'data/keyrings');
  let sandbox: ReturnType<typeof launchSandbox> | undefined;
  const controls = new Set<ReturnType<typeof launchSandbox>>();
  const close = async () => {
    try {
      for (const control of controls) control.child.kill();
      sandbox?.child.kill();
      await Promise.all([...controls].map((control) => control.close()));
      await sandbox?.close();
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  };
  try {
    const services = resolve(home, 'config/services');
    await mkdir(services);
    await writeFile(
      resolve(services, 'org.freedesktop.secrets.service'),
      `[D-BUS Service]\nName=org.freedesktop.secrets\nExec=/usr/bin/mkdir ${keyrings}\n`,
    );
    const config = resolve(home, 'bus.conf');
    await writeFile(
      config,
      `<busconfig><type>session</type><listen>unix:path=${home}/bus</listen><servicedir>${services}</servicedir><auth>EXTERNAL</auth><policy context="default"><allow send_destination="*"/><allow receive_sender="*"/><allow own="*"/></policy></busconfig>`,
    );
    sandbox = launchSandbox(
      home,
      testEnvironment(home),
      executable,
      [`--config-file=${config}`, '--nofork', '--print-address=1'],
      sandboxExecutable,
    );
    const current = sandbox;
    const bus = await new Promise<string>((accept, reject) => {
      const timeout = setTimeout(
        () => reject(new Error('Sandboxed activation bus setup timed out.')),
        2000,
      );
      current.child.stdout.once('data', (address) => {
        clearTimeout(timeout);
        accept(String(address).trim());
      });
      current.child.once('close', () => {
        clearTimeout(timeout);
        reject(current.failure('Sandboxed activation bus setup failed.'));
      });
    });
    testEnvironment(home, {}, bus);
    async function control(args: string[], command = '/usr/bin/busctl') {
      const client = launchSandbox(
        home,
        testEnvironment(home, {}, bus),
        command,
        args,
        sandboxExecutable,
      );
      controls.add(client);
      client.child.stdout.resume();
      const timeout = setTimeout(() => {
        client.child.kill('SIGKILL');
        void client.close();
      }, 1500);
      try {
        return await client.closed;
      } finally {
        clearTimeout(timeout);
        await client.close();
        controls.delete(client);
      }
    }
    return { home, bus, keyrings, close, control };
  } catch (error) {
    await close();
    throw error;
  }
}
