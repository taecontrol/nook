export class CliFailure extends Error {}
export function invalidToken(url: string) {
  return new CliFailure(
    `This machine's token is no longer valid. Run: nook logout && nook login ${url}`,
  );
}
export const keyringMessage =
  process.platform === 'darwin'
    ? 'Nook keeps its token in the macOS login keychain and could not use it. Unlock your login keychain and try again.'
    : 'Nook keeps its token in the Secret Service keyring and could not use it. Install secret-tool (libsecret), unlock your keyring, and try again.';
export class ServerFailure {
  constructor(
    readonly tag: string,
    readonly message?: string,
    readonly paths: readonly string[] = [],
    readonly retryable: boolean = false,
  ) {}
}
