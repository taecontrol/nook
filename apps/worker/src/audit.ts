import { D1Client } from '@effect/sql-d1';
import {
  type AuditEntry,
  type AuditFilters,
  InvalidAuditFilter,
  type RunSecrets,
  splitSecretPath,
  validateBucketPath,
  validateSecretPath,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import type { BucketGrant } from './authorization.ts';

export type AuditMachine = { id: string; machine: string; grant: BucketGrant };
const Facts = Schema.Struct({
  id: Schema.String,
  at: Schema.String,
  path: Schema.String,
  purpose: Schema.String,
  machine_id: Schema.String,
  machine_name: Schema.String,
  working_directory: Schema.String,
});
const Row = Schema.Union([
  Facts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literals(['delivered', 'denied']),
    executable: Schema.String,
    run_id: Schema.String,
  })),
  Facts.mapFields((fields) => ({
    ...fields,
    outcome: Schema.Literal('created'),
    executable: Schema.Null,
    run_id: Schema.Null,
  })),
]);
type Row = typeof Row.Type;
const unavailable = Effect.mapError(
  () => new HttpApiError.ServiceUnavailable(),
);
function entry(row: Row): AuditEntry {
  const facts = {
    id: row.id,
    at: row.at,
    path: row.path,
    ...splitSecretPath(row.path),
    purpose: row.purpose,
    machine: { id: row.machine_id, name: row.machine_name },
    workingDirectory: row.working_directory,
  };
  return row.outcome === 'created'
    ? { ...facts, outcome: row.outcome }
    : {
        ...facts,
        outcome: row.outcome,
        executable: row.executable,
        runId: row.run_id,
      };
}
function encodeCursor(row: { at: string; id: string }) {
  return btoa(JSON.stringify({ at: row.at, id: row.id }))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decodeCursor(cursor?: string) {
  if (!cursor) return undefined;
  const decoded = JSON.parse(
    atob(cursor.replaceAll('-', '+').replaceAll('_', '/')),
  ) as { at: string; id: string };
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      decoded.id,
    ) ||
    new Date(decoded.at).toISOString() !== decoded.at ||
    encodeCursor(decoded) !== cursor
  )
    throw new InvalidAuditFilter();
  return decoded;
}
function filters(input: AuditFilters) {
  return Effect.try({
    try: () => {
      if (
        (input.bucket && validateBucketPath(input.bucket)) ||
        (input.secret && validateSecretPath(input.secret))
      )
        throw new InvalidAuditFilter();
      return {
        bucket: input.bucket ?? '',
        secret: input.secret ?? '',
        cursor: decodeCursor(input.cursor),
      };
    },
    catch: () => new InvalidAuditFilter(),
  });
}
export const auditStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return {
    record: (
      machine: AuditMachine,
      input: RunSecrets,
      paths: readonly string[],
      outcome: 'delivered' | 'denied',
    ) => {
      const run = crypto.randomUUID();
      const at = new Date().toISOString();
      return sql
        .batch(
          paths.map(
            (path) =>
              sql`INSERT INTO audit_entries(id, at, outcome, path, purpose, machine_id, machine_name, working_directory, executable, run_id) VALUES (${crypto.randomUUID()}, ${at}, ${outcome}, ${path}, ${input.purpose}, ${machine.id}, ${machine.machine}, ${input.workingDirectory}, ${input.executable}, ${run})`,
          ),
        )
        .pipe(unavailable, Effect.asVoid);
    },
    list: (grant: BucketGrant, input: AuditFilters) =>
      Effect.gen(function* () {
        if (grant !== 'all')
          return yield* Effect.fail(new HttpApiError.Forbidden());
        const { bucket, secret, cursor } = yield* filters(input);
        const boundary = cursor
          ? sql`(at < ${cursor.at} OR (at = ${cursor.at} AND id < ${cursor.id}))`
          : sql`1`;
        const rows =
          yield* sql<Row>`SELECT * FROM audit_entries WHERE (${bucket} = '' OR path LIKE ${`${bucket}/%`}) AND (${secret} = '' OR path = ${secret}) AND ${boundary} ORDER BY at DESC, id DESC LIMIT 26`.pipe(
            unavailable,
          );
        const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
          rows,
        ).pipe(unavailable);
        const page = decoded.slice(0, 25);
        return {
          entries: page.map(entry),
          next: decoded.length > 25 ? encodeCursor(page[24]) : null,
        };
      }),
  };
});
