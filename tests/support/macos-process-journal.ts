import { expect } from 'vitest';
import {
  type MacProcessGroup,
  readMacProcessGroups,
} from '../../scripts/lib/macos-process-groups.ts';

// Active workers can be registering children; teardown still reads strictly once.
export async function registeredMacProcessGroups(directory: string) {
  let records: MacProcessGroup[] = [];
  await expect
    .poll(async () => {
      records = await readMacProcessGroups(directory);
      return true;
    })
    .toBe(true);
  return records;
}
