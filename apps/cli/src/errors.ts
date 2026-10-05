export class CliFailure extends Error {}
export const keyringMessage =
  'Nook keeps its token in the Secret Service keyring and could not use it. Install secret-tool (libsecret), unlock your keyring, and try again.';
export class ServerFailure {
  constructor(readonly tag: string) {}
}
