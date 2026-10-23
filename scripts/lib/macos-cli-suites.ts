// Linux-only D-Bus, bubblewrap and /proc suites remain in the Linux shards.
// CI runs each group as one macOS job; groups balance observed suite times
// so each job keeps a wide margin under its fifteen-minute timeout.
export const macosCliGroups = [
  [
    'tests/macos-keychain-fixture.test.ts',
    'tests/macos-keyring-policy.test.ts',
    'tests/macos-boundary-policy.test.ts',
    'tests/agent-create-cli.test.ts',
    'tests/nook-json-cli.test.ts',
    'tests/memory-files-cli.test.ts',
    'tests/machine-grant-cli.test.ts',
  ],
  [
    'tests/macos-host-isolation.test.ts',
    'tests/macos-cli.test.ts',
    'tests/macos-cli-timeouts.test.ts',
    'tests/cli-platform.test.ts',
    'tests/cli-release.test.ts',
    'tests/release-archive.test.ts',
    'tests/machines-cli.test.ts',
    'tests/vault-cli.test.ts',
    'tests/run-cli.test.ts',
    'tests/memory-files-transfer-cli.test.ts',
  ],
];
export const macosShards = macosCliGroups.length;
export const macosCliSuites = macosCliGroups.flat();
