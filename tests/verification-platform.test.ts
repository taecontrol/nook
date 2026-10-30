import { expect, it } from 'vitest';
import { inventory } from '../scripts/lib/instrument.ts';
import { requireVerificationPlatform } from '../scripts/lib/verification-platform.ts';

it.each(['pnpm verify', 'pnpm test:coverage'] as const)(
  '#87 E1/E2: %s refuses macOS with Linux and CI alternatives',
  (command) => {
    expect(() => requireVerificationPlatform('darwin', command)).toThrow(
      `${command} runs on Linux. On macOS, CI's macos-cli job runs the macOS suites; run the full check on Linux or push and let CI decide.`,
    );
  },
);

it.each(['pnpm verify', 'pnpm test:coverage'] as const)(
  '#87 E4: %s leaves Linux verification available',
  (command) => {
    expect(() => requireVerificationPlatform('linux', command)).not.toThrow();
  },
);

it('#87 E3: the macOS CLI coverage mode stays available', () => {
  expect(() =>
    requireVerificationPlatform('darwin', 'pnpm test:coverage', true),
  ).not.toThrow();
});

it('#87: the platform gate is in authored coverage scope', async () => {
  expect(await inventory()).toContain('scripts/lib/verification-platform.ts');
});
