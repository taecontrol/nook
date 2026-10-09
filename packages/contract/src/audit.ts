import { Schema } from 'effect';

const EntryFacts = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  path: Schema.String,
  bucket: Schema.String,
  name: Schema.String,
  purpose: Schema.String,
});
const MachineFacts = EntryFacts.mapFields((fields) => ({
  ...fields,
  machine: Schema.Struct({ id: Schema.String, name: Schema.String }),
  workingDirectory: Schema.String,
}));
export const AuditEntry = Schema.Union([
  MachineFacts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literals(['delivered', 'denied']),
    executable: Schema.String,
    runId: Schema.String,
  })),
  MachineFacts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literal('created'),
  })),
  EntryFacts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literal('revealed'),
    ip: Schema.NullOr(Schema.String),
    country: Schema.NullOr(Schema.String),
  })),
]);
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
