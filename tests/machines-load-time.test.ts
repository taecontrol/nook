import { expect, it } from 'vitest';
import {
  assertLoadTimes,
  formatMeasurements,
} from '../scripts/lib/load-time.ts';

const measured = {
  home: [500, 500, 500, 500, 500],
  buckets: [500, 500, 500, 500, 500],
  navigation: [20, 20, 20, 20, 20],
  authorize: [500, 500, 500, 500, 500],
  machines: [1000, 1000, 1000, 1000, 1000],
  machinesNavigation: [100, 100, 100, 100, 100],
  approvalNavigation: [100, 100, 100, 100, 100],
  vault: Array(5).fill(500),
  vaultNavigation: Array(5).fill(20),
  audit: Array(5).fill(500),
  auditNavigation: Array(5).fill(20),
  memory: Array(5).fill(500),
  memoryNavigation: Array(5).fill(20),
};
it.each(['machines', 'machinesNavigation'])(
  'E25: an over-budget %s fails for its own timing',
  (kind) => {
    expect(() =>
      assertLoadTimes({
        ...measured,
        [kind]: Array(5).fill(kind === 'machines' ? 1001 : 101),
      }),
    ).toThrow(/machines/i);
  },
);
it('E25: both machine timings are required, printed, and accept the exact fixed limits', () => {
  expect(() => assertLoadTimes(measured)).not.toThrow();
  const missingCold = { ...measured, machines: [] };
  const missingNavigation = { ...measured, machinesNavigation: [] };
  expect(() => assertLoadTimes(missingCold)).toThrow();
  expect(() => assertLoadTimes(missingNavigation)).toThrow();
  expect(JSON.parse(formatMeasurements(measured)).medianMs).toMatchObject({
    machines: 1000,
    machinesNavigation: 100,
  });
});
