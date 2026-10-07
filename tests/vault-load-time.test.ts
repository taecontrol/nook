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
  machines: [500, 500, 500, 500, 500],
  machinesNavigation: [20, 20, 20, 20, 20],
  approvalNavigation: [20, 20, 20, 20, 20],
  vault: [1000, 1000, 1000, 1000, 1000],
  vaultNavigation: [100, 100, 100, 100, 100],
};
it.each(['vault', 'vaultNavigation'])(
  'E23: the existing stage rejects an over-budget %s',
  (kind) => {
    expect(() =>
      assertLoadTimes({
        ...measured,
        [kind]: Array(5).fill(kind === 'vault' ? 1001 : 101),
      }),
    ).toThrow(/vault/i);
  },
);
it('E23: both Vault timings are required, printed, and accept the exact fixed budgets', () => {
  expect(() => assertLoadTimes(measured)).not.toThrow();
  const missingCold = { ...measured, vault: [] };
  const missingNavigation = { ...measured, vaultNavigation: [] };
  expect(() => assertLoadTimes(missingCold)).toThrow();
  expect(() => assertLoadTimes(missingNavigation)).toThrow();
  expect(JSON.parse(formatMeasurements(measured)).medianMs).toMatchObject({
    vault: 1000,
    vaultNavigation: 100,
  });
});
