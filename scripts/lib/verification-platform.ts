export function requireVerificationPlatform(
  platform: NodeJS.Platform,
  command: 'pnpm verify' | 'pnpm test:coverage',
  macosCli = false,
) {
  if (platform === 'darwin' && !macosCli)
    throw new Error(
      `${command} runs on Linux. On macOS, CI's macos-cli job runs the macOS suites; run the full check on Linux or push and let CI decide.`,
    );
}
