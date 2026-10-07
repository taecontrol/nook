import { expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
} from '../scripts/lib/load-time.ts';

const measured = {
  home: Array(5).fill(500),
  buckets: Array(5).fill(500),
  navigation: Array(5).fill(50),
  authorize: Array(5).fill(500),
  machines: Array(5).fill(500),
  machinesNavigation: Array(5).fill(50),
  approvalNavigation: Array(5).fill(100),
  vault: Array(5).fill(500),
  vaultNavigation: Array(5).fill(20),
};
it('E32: loaded approval tree timing is mandatory, independently limited to 100 ms, and printed', () => {
  expect(() =>
    assertLoadTimes({ ...measured, approvalNavigation: Array(5).fill(101) }),
  ).toThrow(/approval/i);
  expect(() =>
    assertLoadTimes({ ...measured, approvalNavigation: [] }),
  ).toThrow();
  expect(() => assertLoadTimes(measured)).not.toThrow();
  expect(
    JSON.parse(formatMeasurements(measured)).medianMs.approvalNavigation,
  ).toBe(100);
});
