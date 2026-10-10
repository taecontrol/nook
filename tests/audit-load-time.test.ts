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
  audit: Array(5).fill(1000),
  auditNavigation: Array(5).fill(100),
  memory: Array(5).fill(500),
  memoryNavigation: Array(5).fill(20),
};
it.each(['audit', 'auditNavigation'])(
  'E25: Audit medians independently enforce the fixed budget (%s)',
  (key) => {
    expect(() =>
      assertLoadTimes({
        ...measured,
        [key]: Array(5).fill(key === 'audit' ? 1001 : 101),
      }),
    ).toThrow(/audit/i);
  },
);
it('E25: Audit timings are required, printed, and accept exact limits', () => {
  expect(() => assertLoadTimes(measured)).not.toThrow();
  const missing = { ...measured, audit: [] };
  expect(() => assertLoadTimes(missing)).toThrow();
  const missingNavigation = { ...measured, auditNavigation: [] };
  expect(() => assertLoadTimes(missingNavigation)).toThrow();
  expect(JSON.parse(formatMeasurements(measured)).medianMs).toMatchObject({
    audit: 1000,
    auditNavigation: 100,
  });
});
