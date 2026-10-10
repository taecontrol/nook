import { expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
} from '../scripts/lib/load-time.ts';

const measured = {
  home: Array(5).fill(500),
  buckets: Array(5).fill(500),
  navigation: Array(5).fill(20),
  authorize: Array(5).fill(500),
  machines: Array(5).fill(500),
  machinesNavigation: Array(5).fill(20),
  approvalNavigation: Array(5).fill(20),
  vault: Array(5).fill(500),
  vaultNavigation: Array(5).fill(20),
  audit: Array(5).fill(500),
  auditNavigation: Array(5).fill(20),
  memory: Array(5).fill(500),
  memoryNavigation: Array(5).fill(20),
};
it.each([
  ['memory', 1001],
  ['memoryNavigation', 101],
] as const)('E31: the %s budget fails independently', (key, value) => {
  expect(() =>
    assertLoadTimes({ ...measured, [key]: Array(5).fill(value) }),
  ).toThrow(/memory/i);
  expect(() => assertLoadTimes({ ...measured, [key]: [] })).toThrow();
});
it('E31: five samples and both Memory medians are mandatory in diagnostics', () => {
  expect(() => assertLoadTimes(measured)).not.toThrow();
  expect(JSON.parse(formatMeasurements(measured)).medianMs).toMatchObject({
    memory: 500,
    memoryNavigation: 20,
  });
});
