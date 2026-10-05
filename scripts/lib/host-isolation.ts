import { rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import {
  killOrphans,
  orphanedProcesses,
  snapshotProcesses,
} from './host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
  ownerResources,
} from './host-resources.ts';
import { temporaryTestHome, testEnvironment } from './test-environment.ts';

export async function startHostIsolation(
  resources: { directories: string[] } = ownerResources(process.env),
) {
  const before = await fingerprintHost(resources);
  const processes = await snapshotProcesses();
  const original = Object.fromEntries(Object.entries(process.env));
  const home = await temporaryTestHome();
  const run = {
    id: crypto.randomUUID(),
    pid: process.pid,
    home,
    parentId: original.NOOK_TEST_RUN,
  };
  const env = testEnvironment(home, {
    NOOK_TEST_RUN: run.id,
    COVERAGE_RUN: original.COVERAGE_RUN,
    NOOK_BUILD: original.NOOK_BUILD,
    CI: original.CI,
    FORCE_COLOR: original.FORCE_COLOR,
    E2E_TELEMETRY_DISABLED: '1',
    PLAYWRIGHT_BROWSERS_PATH:
      original.PLAYWRIGHT_BROWSERS_PATH ??
      resolve(
        original.XDG_CACHE_HOME || resolve(userInfo().homedir, '.cache'),
        'ms-playwright',
      ),
  });
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  const close = async () => {
    try {
      const orphans = orphanedProcesses(
        processes,
        await snapshotProcesses(),
        run,
      );
      const messages = await killOrphans(orphans);
      assertHostUnchanged(before, await fingerprintHost(resources), messages);
    } finally {
      await rm(home, { recursive: true, force: true });
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, original);
    }
  };
  return { home, env, close };
}

export default async function setup() {
  return (await startHostIsolation()).close;
}
