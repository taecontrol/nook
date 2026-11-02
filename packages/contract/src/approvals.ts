import { Schema } from 'effect';
import { AgentSessionClaim } from './agent-session.ts';
import { WriteId } from './vault.ts';

export const Remember = Schema.Literals(['once', '1h', '12h']);
export type Remember = typeof Remember.Type;
export const rememberDuration: Record<Remember, number> = {
  once: 120_000,
  '1h': 3_600_000,
  '12h': 43_200_000,
};
export const ApprovalAttempt = Schema.Struct({ attemptId: WriteId });
export const AskFirstMark = Schema.Struct({
  kind: Schema.Literals(['bucket', 'secret']),
  path: Schema.String,
});
export type AskFirstMark = typeof AskFirstMark.Type;
export function coveringMark(
  marks: readonly AskFirstMark[],
  path: string,
): AskFirstMark | null {
  return (
    marks.find((mark) =>
      mark.kind === 'secret'
        ? mark.path === path
        : path.startsWith(`${mark.path}/`),
    ) ?? null
  );
}
export const AskFirstList = Schema.Struct({
  marks: Schema.Array(
    AskFirstMark.mapFields((fields) => ({ ...fields, exists: Schema.Boolean })),
  ),
});
export const ApprovalPending = Schema.Struct({
  approval: Schema.Struct({
    id: Schema.String,
    url: Schema.String,
    paths: Schema.Array(Schema.String),
    expiresAt: Schema.String,
    expiresIn: Schema.Number,
    interval: Schema.Number,
  }),
});
export type ApprovalPending = typeof ApprovalPending.Type;
export const ApprovalReference = Schema.Struct({
  id: Schema.String,
  remember: Remember,
});
export type ApprovalReference = typeof ApprovalReference.Type;
const facts = {
  id: Schema.String,
  verified: Schema.Struct({
    machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
    secrets: Schema.Array(
      Schema.Struct({
        path: Schema.String,
        coveredBy: Schema.NullOr(AskFirstMark),
      }),
    ),
  }),
  claimed: Schema.Struct({
    purpose: Schema.String,
    workingDirectory: Schema.String,
    executable: Schema.String,
    session: Schema.NullOr(AgentSessionClaim),
    client: Schema.NullOr(Schema.String),
  }),
  requestedAt: Schema.String,
  expiresAt: Schema.String,
};
export const ApprovalView = Schema.Union([
  Schema.Struct({
    ...facts,
    state: Schema.Literals(['pending', 'withdrawn', 'expired', 'settled']),
  }),
  Schema.Struct({
    ...facts,
    state: Schema.Literal('approved'),
    remember: Remember,
    decidedAt: Schema.String,
    validUntil: Schema.String,
  }),
  Schema.Struct({
    ...facts,
    state: Schema.Literal('denied'),
    decidedAt: Schema.String,
  }),
]);
export type ApprovalView = typeof ApprovalView.Type;
export const ApprovalList = Schema.Struct({
  pending: Schema.Array(ApprovalView),
  remembered: Schema.Array(ApprovalView),
});
export class ApprovalDenied extends Schema.Error<ApprovalDenied>(
  'nook/ApprovalDenied',
)(
  { _tag: Schema.tag('ApprovalDenied'), paths: Schema.Array(Schema.String) },
  { httpApiStatus: 403 },
) {}
export class ApprovalExpired extends Schema.Error<ApprovalExpired>(
  'nook/ApprovalExpired',
)(
  {
    _tag: Schema.tag('ApprovalExpired'),
    reason: Schema.Literals(['expired', 'withdrawn']),
  },
  { httpApiStatus: 410 },
) {}
export class ApprovalLimit extends Schema.Error<ApprovalLimit>(
  'nook/ApprovalLimit',
)(
  { _tag: Schema.tag('ApprovalLimit'), message: Schema.String },
  { httpApiStatus: 429 },
) {}
export class ApprovalAlreadyHandled extends Schema.Error<ApprovalAlreadyHandled>(
  'nook/ApprovalAlreadyHandled',
)(
  {
    _tag: Schema.tag('AlreadyHandled'),
    status: Schema.Literals(['approved', 'denied', 'withdrawn', 'settled']),
    remember: Schema.NullOr(Remember),
  },
  { httpApiStatus: 409 },
) {}
