import { Schema } from 'effect';
import { MemoryClient, Principal } from './provenance.ts';

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
export const VaultAuditEntry = Schema.Union([
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
export type VaultAuditEntry = typeof VaultAuditEntry.Type;
export const FileAuditOutcome = Schema.Literals([
  'file_attached',
  'file_replaced',
  'file_downloaded',
  'file_detached',
  'file_forgotten',
]);
export type FileAuditOutcome = typeof FileAuditOutcome.Type;
export const FileAuditEntry = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  outcome: FileAuditOutcome,
  bucket: Schema.String,
  memoryId: Schema.String,
  name: Schema.String,
  size: Schema.Number,
  sha256: Schema.String,
  replacedSha256: Schema.NullOr(Schema.String),
  principal: Principal,
  client: MemoryClient,
  ip: Schema.NullOr(Schema.String),
  country: Schema.NullOr(Schema.String),
});
export type FileAuditEntry = typeof FileAuditEntry.Type;
export const AuditEntry = Schema.Union([VaultAuditEntry, FileAuditEntry]);
export type AuditEntry = typeof AuditEntry.Type;
export function isFileAuditEntry(entry: AuditEntry): entry is FileAuditEntry {
  return 'memoryId' in entry;
}
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
