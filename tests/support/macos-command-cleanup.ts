import { existsSync } from 'node:fs';
import { userInfo } from 'node:os';
import {
  type HostProcess,
  killOrphans,
  macGroupProcesses,
  snapshotProcesses,
} from '../../scripts/lib/host-processes.ts';
import {
  readMacProcessGroups,
  requireMacProcessRegistry,
} from '../../scripts/lib/macos-process-groups.ts';

// The fixture's journal includes grandchildren in their own detached groups.
// Run ancestry would also select another fixture's children, so never use it here.
export async function stopMacFixtureGroups(
  before: HostProcess[],
  directory: string,
) {
  if (!existsSync(directory))
    throw new Error(
      'macOS fixture process-group journal is missing; temporary HOME was preserved.',
    );
  const { root } = requireMacProcessRegistry();
  for (let attempt = 0; attempt < 20; attempt++) {
    const groups = await readMacProcessGroups(directory).catch(() => {
      throw new Error(
        'macOS fixture process-group journal could not be verified; temporary HOME was preserved.',
      );
    });
    if (groups.some((record) => record.root !== root))
      throw new Error(
        'macOS fixture journal has a foreign run root; temporary HOME was preserved.',
      );
    const after = await snapshotProcesses();
    const { owned, ambiguous } = macGroupProcesses(before, after, {
      id: 'macos-fixture',
      home: '',
      pid: root,
      uid: userInfo().uid,
      groups,
    });
    if (ambiguous.length)
      throw new Error(
        'macOS fixture cleanup could not verify a recorded group generation. No signal was sent to it; temporary HOME was preserved.',
      );
    if (!owned.length) return;
    await killOrphans(owned);
    await new Promise((accept) => setTimeout(accept, 50));
  }
  throw new Error(
    'macOS fixture commands did not exit; temporary HOME was preserved.',
  );
}
