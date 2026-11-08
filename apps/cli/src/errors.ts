import type { ApprovalExpired } from '@nook/contract';
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
export function accessDateTime(iso: string) {
  return new Intl.DateTimeFormat('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(iso));
}
/** Relative access lifetime in minutes, hours or days. Never zero minutes. */
export function untilText(iso: string, now: number) {
  const remaining = Date.parse(iso) - now;
  const minutes = Math.max(1, Math.ceil(remaining / 60_000));
  const [amount, unit] =
    minutes < 60
      ? [minutes, 'minute']
      : remaining < 86_400_000
        ? [Math.ceil(minutes / 60), 'hour']
        : [Math.ceil(minutes / 1440), 'day'];
  return `in ${amount} ${unit}${amount === 1 ? '' : 's'}`;
}
export function expiredAccess(url: string, expiredAt: string) {
  return new CliFailure(
    `This machine's access expired on ${accessDateTime(expiredAt)}. Run: nook logout && nook login ${url}`,
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
    readonly expiredAt?: string,
    readonly approvalReason?: ApprovalExpired['reason'],
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
