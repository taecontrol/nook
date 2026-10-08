import { Schema } from 'effect';
export const AuditEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  outcome: Schema.Literals(['delivered', 'denied']),
  path: Schema.String,
  bucket: Schema.String,
  name: Schema.String,
  purpose: Schema.String,
  machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
  workingDirectory: Schema.String,
  executable: Schema.String,
  runId: Schema.String,
});
export type AuditEntry = typeof AuditEntry.Type;
export const AuditFilters = Schema.Struct({
  bucket: Schema.optionalKey(Schema.String),
  secret: Schema.optionalKey(Schema.String),
  cursor: Schema.optionalKey(Schema.String),
});
export type AuditFilters = typeof AuditFilters.Type;
export const AuditPage = Schema.Struct({
  entries: Schema.Array(AuditEntry),
  next: Schema.NullOr(Schema.String),
});
export class InvalidAuditFilter extends Schema.Error<InvalidAuditFilter>(
  'nook/InvalidAuditFilter',
)({ _tag: Schema.tag('InvalidAuditFilter') }, { httpApiStatus: 400 }) {}
