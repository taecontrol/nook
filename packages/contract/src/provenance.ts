import { Schema } from 'effect';

export const Principal = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('owner') }),
  Schema.Struct({
    kind: Schema.Literal('machine'),
    id: Schema.String,
    name: Schema.String,
  }),
]);
export type Principal = typeof Principal.Type;
export const MemoryClient = Schema.Struct({
  name: Schema.String,
  version: Schema.NullOr(Schema.String),
});
export type MemoryClient = typeof MemoryClient.Type;
export const Provenance = Schema.Struct({
  client: MemoryClient,
  principal: Principal,
  workingDirectory: Schema.NullOr(Schema.String),
  at: Schema.String,
});
export type Provenance = typeof Provenance.Type;
