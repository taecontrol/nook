// Linux-only D-Bus, bubblewrap and /proc suites remain in the Linux shards.
export const macosCliSuites = [
  'tests/macos-keychain-fixture.test.ts',
  'tests/macos-host-isolation.test.ts',
  'tests/macos-cli.test.ts',
  'tests/macos-cli-timeouts.test.ts',
  'tests/macos-keyring-policy.test.ts',
  'tests/macos-boundary-policy.test.ts',
  'tests/cli-platform.test.ts',
  'tests/cli-release.test.ts',
  'tests/release-archive.test.ts',
  'tests/machines-cli.test.ts',
  'tests/machine-grant-cli.test.ts',
  'tests/vault-cli.test.ts',
  'tests/run-cli.test.ts',
];
