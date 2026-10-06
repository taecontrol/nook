import { mkdir, rm } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { resolve } from 'node:path';
import type { TestProject } from 'vitest/node';
import {
  type HostProcess,
  killOrphans,
  orphanedProcesses,
  type ProcessRun,
  snapshotProcesses,
  unverifiedMacProcesses,
} from './host-processes.ts';
import {
  assertHostUnchanged,
  fingerprintHost,
  type HostResources,
  ownerResources,
} from './host-resources.ts';
import { readMacProcessGroups } from './macos-process-groups.ts';
import { temporaryTestHome, testEnvironment } from './test-environment.ts';

async function cleanupProcesses(
  processes: HostProcess[],
  run: ProcessRun,
  groups: string,
) {
  const recorded =
    process.platform === 'darwin' ? await readMacProcessGroups(groups) : [];
  const afterProcesses = await snapshotProcesses();
  const identity = { ...run, groups: recorded };
  const orphans = orphanedProcesses(processes, afterProcesses, identity);
  for (const orphan of orphans)
    console.log(
      JSON.stringify({
        orphanObservation: 'after',
        pid: orphan.pid,
        group: orphan.group,
        name: orphan.name,
      }),
    );
  const messages = await killOrphans(orphans);
  if (process.platform === 'darwin')
    for (const item of unverifiedMacProcesses(
      processes,
      afterProcesses,
      identity,
    ))
      messages.push(
        `macOS process group ${item.group} has no surviving recorded identity; no signal was sent to PID ${item.pid}`,
      );
  return messages;
}

export async function startHostIsolation(
  resources: HostResources = ownerResources(process.env),
) {
  const before = await fingerprintHost(resources);
  if (before.keychain)
    console.log(
      JSON.stringify({ keychainObservation: 'before', ...before.keychain }),
    );
  const processes = await snapshotProcesses();
  const original = Object.fromEntries(Object.entries(process.env));
  const home = await temporaryTestHome();
  const groups = resolve(home, 'process-groups');
  if (process.platform === 'darwin') await mkdir(groups, { mode: 0o700 });
  const run = {
    id: crypto.randomUUID(),
    pid: process.pid,
    home,
    uid: userInfo().uid,
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
    ...(process.platform === 'darwin'
      ? {
          NOOK_TEST_PROCESS_GROUPS: groups,
          NOOK_TEST_ROOT_PID: String(run.pid),
        }
      : {}),
  });
  for (const name of Object.keys(process.env)) delete process.env[name];
  Object.assign(process.env, env);
  const close = async () => {
    try {
      const messages = await cleanupProcesses(processes, run, groups);
      const after = await fingerprintHost(resources);
      if (after.keychain)
        console.log(
          JSON.stringify({ keychainObservation: 'after', ...after.keychain }),
        );
      assertHostUnchanged(before, after, messages);
      if (after.keychain)
        console.log(
          'Host isolation: owner Keychain paths and entry names/kinds unchanged; no orphaned fixture processes.',
        );
    } finally {
      await rm(home, { recursive: true, force: true });
      for (const name of Object.keys(process.env)) delete process.env[name];
      Object.assign(process.env, original);
    }
  };
  return { home, env, close };
}

export default async function setup(project: TestProject) {
  const isolation = await startHostIsolation();
  // Global teardown precedes pool.close(); normal workers are not yet orphans.
  project.vitest.onClose(isolation.close);
}
