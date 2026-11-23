import type { ApprovalExpired } from '@nook/contract';

export class CliFailure extends Error {}
export class NotLoggedIn extends CliFailure {}
export function errorCode(error: unknown) {
  return error instanceof Error &&
    'code' in error &&
    typeof error.code === 'string'
    ? error.code
    : undefined;
}
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
export class ServerFailure {
  readonly tag: string;
  readonly message?: string;
  readonly paths: readonly string[];
  readonly retryable: boolean;
  readonly expiredAt?: string;
  readonly approvalReason?: ApprovalExpired['reason'];
  constructor({
    tag,
    message,
    paths = [],
    retryable = false,
    expiredAt,
    approvalReason,
  }: {
    readonly tag: string;
    readonly message?: string;
    readonly paths?: readonly string[];
    readonly retryable?: boolean;
    readonly expiredAt?: string;
    readonly approvalReason?: ApprovalExpired['reason'];
  }) {
    this.tag = tag;
    this.message = message;
    this.paths = paths;
    this.retryable = retryable;
    this.expiredAt = expiredAt;
    this.approvalReason = approvalReason;
  }
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
