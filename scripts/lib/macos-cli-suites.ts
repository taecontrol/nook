// Linux-only D-Bus, bubblewrap and /proc suites remain in the Linux shards.
export const macosCliSuites = [
  'tests/macos-keychain-fixture.test.ts',
  'tests/macos-host-isolation.test.ts',
  'tests/macos-cli.test.ts',
  'tests/macos-cli-timeouts.test.ts',
  'tests/cli-platform.test.ts',
  'tests/cli-release.test.ts',
  'tests/machines-cli.test.ts',
  'tests/machine-grant-cli.test.ts',
];
