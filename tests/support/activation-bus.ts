import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  temporaryTestHome,
  testEnvironment,
} from '../../scripts/lib/test-environment.ts';

export async function activationBus(executable = '/usr/bin/dbus-daemon') {
  const home = await temporaryTestHome();
  const keyrings = resolve(home, 'data/keyrings');
  let daemon: ReturnType<typeof spawn> | undefined;
  let exited: Promise<unknown> = Promise.resolve();
  const close = async () => {
    try {
      daemon?.kill();
      await exited;
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
    const child = spawn(
      executable,
      [`--config-file=${config}`, '--nofork', '--print-address=1'],
      { env: testEnvironment(home), stdio: ['ignore', 'pipe', 'ignore'] },
    );
    daemon = child;
    exited = once(child, 'exit').catch(() => undefined);
    await once(child, 'spawn');
    const [address] = await once(child.stdout, 'data', {
      signal: AbortSignal.timeout(2000),
    });
    const bus = String(address).trim();
    testEnvironment(home, {}, bus);
    return { home, bus, keyrings, close };
  } catch (error) {
    await close();
    throw error;
  }
}
