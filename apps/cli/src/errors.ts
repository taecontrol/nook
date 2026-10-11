import { Effect } from 'effect';

export class CliFailure extends Error {}
export class NotLoggedIn extends CliFailure {}
export function networkError(url: string) {
  return new CliFailure(`Could not reach ${url}. Try again.`);
}
export function invalidToken(url: string) {
  return new CliFailure(
    `This machine's token is no longer valid. Run: nook logout && nook login ${url}`,
  );
}
// Lifts a synchronous check whose only failure is a thrown CliFailure.
export function tryCli<A>(check: () => A) {
  return Effect.try({ try: check, catch: (error) => error as CliFailure });
}
export class ServerFailure {
  constructor(
    readonly tag: string,
    readonly message?: string,
    readonly paths: readonly string[] = [],
    readonly retryable: boolean = false,
  ) {}
}
export class RequestFailure extends CliFailure {
  constructor(
    message: string,
    readonly server: ServerFailure,
    readonly publicMessage?: string,
  ) {
    super(message);
  }
}
