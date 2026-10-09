import { D1Client } from '@effect/sql-d1';
import {
  BucketNotFound,
  type CreateMachineSecret,
  type CreateSecret,
  InvalidBucketPath,
  InvalidRun,
  InvalidSecret,
  type OwnerSecret,
  type ReplaceSecret,
  type Secret,
  SecretChanged,
  SecretExists,
  SecretKeyUnavailable,
  SecretNotFound,
  secretLineage,
  secretPath,
  validateBucketPath,
  validatePurpose,
  validateSecretDescription,
  validateSecretName,
  validateSecretValue,
  validateWorkingDirectory,
} from '@nook/contract';
import { Effect, Redacted, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { SqlSchema } from 'effect/sql';
import { type AuditMachine, auditStore } from './audit.ts';
import { type BucketGrant, canRead, canWrite } from './authorization.ts';
import { open, parseKeyring, seal } from './vault-keyring.ts';

const Row = Schema.Struct({
  bucket: Schema.String,
  name: Schema.String,
  description: Schema.String,
  updated_at: Schema.String,
  version: Schema.String,
});
type Row = typeof Row.Type;
const Envelope = Schema.Struct({
  key_id: Schema.String,
  iv: Schema.String,
  ciphertext: Schema.String,
});
type CreateState = Partial<Row> & { has_bucket: number };
const unavailable = Effect.mapError(
  () => new HttpApiError.ServiceUnavailable(),
);
function metadata(row: Row): OwnerSecret {
  return {
    bucket: row.bucket,
    name: row.name,
    path: secretPath(row),
    description: row.description,
    updatedAt: row.updated_at,
    version: row.version,
  };
}
function publicMetadata(secret: OwnerSecret): Secret {
  return {
    bucket: secret.bucket,
    name: secret.name,
    path: secret.path,
    description: secret.description,
    updatedAt: secret.updatedAt,
  };
}
function byName(a: Secret, b: Secret) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
function authorized(grant: BucketGrant, bucket: string, write: boolean) {
  const message = validateBucketPath(bucket);
  if (message) return Effect.fail(new InvalidBucketPath({ message }));
  if (!(write ? canWrite(grant, bucket) : canRead(grant, bucket)))
    return Effect.fail(new HttpApiError.Forbidden());
  return Effect.void;
}
function validName(name: string) {
  const message = validateSecretName(name);
  return message ? Effect.fail(new InvalidSecret({ message })) : Effect.void;
}
function validValue(input: CreateSecret | ReplaceSecret) {
  const message =
    validateSecretDescription(input.description ?? '') ??
    validateSecretValue(Redacted.value(input.value));
  return message ? Effect.fail(new InvalidSecret({ message })) : Effect.void;
}
function target(grant: BucketGrant, path: string, write = true) {
  return Effect.gen(function* () {
    const separator = path.lastIndexOf('/');
    const bucket = path.slice(0, separator);
    const name = path.slice(separator + 1);
    yield* authorized(grant, bucket, write);
    yield* validName(name);
    return { bucket, name };
  });
}
function missingSecret() {
  return new SecretNotFound({ message: 'Secret not found.' });
}
function changed(path: string) {
  return new SecretChanged({
    message: `${path} changed in another session. Review it and try again.`,
  });
}
function createOutcome(
  inserted: readonly Row[],
  state: CreateState,
  writeId: string,
  path: string,
) {
  const row =
    inserted[0] ?? (state.version === writeId ? (state as Row) : undefined);
  if (row) return Effect.succeed(metadata(row));
  if (!state.has_bucket)
    return Effect.fail(new BucketNotFound({ message: 'Bucket not found.' }));
  return Effect.fail(new SecretExists({ message: `${path} already exists.` }));
}
function replaceOutcome(
  updated: readonly Row[],
  remaining: readonly Row[],
  writeId: string,
  path: string,
) {
  const row =
    updated[0] ?? remaining.find((entry) => entry.version === writeId);
  if (row) return Effect.succeed(metadata(row));
  return Effect.fail(remaining.length ? changed(path) : missingSecret());
}
const readStore = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  return (grant: BucketGrant, bucket: string) =>
    Effect.gen(function* () {
      yield* authorized(grant, bucket, false);
      const lineage = secretLineage(bucket).filter((path) =>
        canRead(grant, path),
      );
      const [exists, rows] = yield* sql
        .batch([
          sql`SELECT path FROM buckets WHERE path = ${bucket}`,
          sql<Row>`SELECT bucket, name, description, updated_at, version FROM secrets WHERE ${sql.in('bucket', lineage)}`,
        ])
        .pipe(unavailable);
      if (!exists.length)
        return yield* Effect.fail(
          new BucketNotFound({ message: 'Bucket not found.' }),
        );
      const decoded = yield* Schema.decodeUnknownEffect(Schema.Array(Row))(
        rows,
      ).pipe(unavailable);
      return {
        secrets: decoded
          .map(metadata)
          .map(publicMetadata)
          .sort(
            (a, b) =>
              lineage.indexOf(a.bucket) - lineage.indexOf(b.bucket) ||
              byName(a, b),
          ),
      };
    });
});
type Creation = {
  machine: Pick<AuditMachine, 'id' | 'machine'>;
  input: CreateMachineSecret;
};
function createStore(binding: string, grant: BucketGrant) {
  return Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    return (input: CreateSecret, creation?: Creation) =>
      Effect.gen(function* () {
        yield* authorized(grant, input.bucket, true);
        yield* validName(input.name);
        yield* validValue(input);
        const ring = yield* parseKeyring(binding);
        const path = secretPath(input);
        const envelope = yield* seal(ring, path, input.value);
        const now = new Date().toISOString();
        // The state SELECT below preserves changes() from the secret INSERT.
        const audit = creation
          ? [
              sql`INSERT INTO audit_entries(id, at, outcome, path, purpose, machine_id, machine_name, working_directory) SELECT ${crypto.randomUUID()}, ${now}, 'created', ${path}, ${creation.input.purpose}, ${creation.machine.id}, ${creation.machine.machine}, ${creation.input.workingDirectory} WHERE changes() = 1`,
            ]
          : [];
        const [inserted, states] = yield* sql
          .batch([
            sql<Row>`INSERT INTO secrets(bucket, name, description, version, key_id, iv, ciphertext, created_at, updated_at) SELECT ${input.bucket}, ${input.name}, ${input.description ?? ''}, ${input.writeId}, ${envelope.key_id}, ${envelope.iv}, ${envelope.ciphertext}, ${now}, ${now} WHERE EXISTS (SELECT 1 FROM buckets WHERE path = ${input.bucket}) ON CONFLICT(bucket, name) DO NOTHING RETURNING bucket, name, description, updated_at, version`,
            sql<CreateState>`SELECT EXISTS(SELECT 1 FROM buckets WHERE path = ${input.bucket}) AS has_bucket, bucket, name, description, updated_at, version FROM (SELECT 1) LEFT JOIN secrets ON bucket = ${input.bucket} AND name = ${input.name}`,
            ...audit,
          ])
          .pipe(unavailable);
        return yield* createOutcome(inserted, states[0], input.writeId, path);
      });
  });
}
// This face deliberately has no value read, replace, or remove capability.
export function machineVault(grant: BucketGrant, binding = '') {
  return Effect.gen(function* () {
    const list = yield* readStore;
    const create = yield* createStore(binding, grant);
    return {
      list: (bucket: string) => list(grant, bucket),
      create: (machine: Creation['machine'], input: CreateMachineSecret) =>
        Effect.gen(function* () {
          const message =
            validatePurpose(input.purpose) ??
            validateWorkingDirectory(input.workingDirectory);
          if (message) return yield* Effect.fail(new InvalidRun({ message }));
          return yield* create(input, { machine, input }).pipe(
            Effect.map(publicMetadata),
            Effect.catchTag('InvalidBucketPath', (error) =>
              Effect.fail(new InvalidSecret({ message: error.message })),
            ),
          );
        }),
    };
  });
}
export function ownerVault(binding = '', grant: BucketGrant = 'all') {
  return Effect.gen(function* () {
    const sql = yield* D1Client.D1Client;
    const read = yield* readStore;
    const create = yield* createStore(binding, grant);
    const audit = yield* auditStore;
    const listRows = SqlSchema.findAll({
      Request: Schema.Void,
      Result: Row,
      execute: () =>
        sql`SELECT bucket, name, description, updated_at, version FROM secrets ORDER BY bucket, name`,
    });
    return {
      reveal: (
        path: string,
        facts: { ip: string | null; country: string | null },
      ) =>
        Effect.gen(function* () {
          const { bucket, name } = yield* target(grant, path, false);
          const rows =
            yield* sql`SELECT key_id, iv, ciphertext FROM secrets WHERE bucket = ${bucket} AND name = ${name}`.pipe(
              unavailable,
            );
          if (!rows.length) return yield* Effect.fail(missingSecret());
          const envelope = yield* Schema.decodeUnknownEffect(Envelope)(
            rows[0],
          ).pipe(unavailable);
          const ring = yield* parseKeyring(binding);
          const value = yield* open(ring, path, envelope).pipe(
            Effect.mapError(
              () =>
                new SecretKeyUnavailable({
                  message: `Cannot open a secret encrypted with key ${envelope.key_id}.`,
                }),
            ),
          );
          yield* audit.recordReveal(path, facts);
          return { value };
        }),
      list: (bucket: string) => read(grant, bucket),
      listAll: () =>
        grant === 'all'
          ? listRows().pipe(
              unavailable,
              Effect.map((rows) => ({ secrets: rows.map(metadata) })),
            )
          : Effect.fail(new HttpApiError.Forbidden()),
      create: (input: CreateSecret) => create(input),
      replace: (path: string, input: ReplaceSecret) =>
        Effect.gen(function* () {
          const { bucket, name } = yield* target(grant, path);
          yield* validValue(input);
          const ring = yield* parseKeyring(binding);
          const envelope = yield* seal(ring, path, input.value);
          const now = new Date().toISOString();
          const [updated, remaining] = yield* sql
            .batch([
              sql<Row>`UPDATE secrets SET description = ${input.description ?? ''}, version = ${input.writeId}, key_id = ${envelope.key_id}, iv = ${envelope.iv}, ciphertext = ${envelope.ciphertext}, updated_at = CASE WHEN updated_at >= ${now} THEN strftime('%Y-%m-%dT%H:%M:%fZ', updated_at, '+0.001 seconds') ELSE ${now} END WHERE bucket = ${bucket} AND name = ${name} AND version = ${input.expectedVersion} AND version <> ${input.writeId} RETURNING bucket, name, description, updated_at, version`,
              sql<Row>`SELECT bucket, name, description, updated_at, version FROM secrets WHERE bucket = ${bucket} AND name = ${name}`,
            ])
            .pipe(unavailable);
          return yield* replaceOutcome(updated, remaining, input.writeId, path);
        }),
      remove: (path: string, expectedVersion: string) =>
        Effect.gen(function* () {
          const { bucket, name } = yield* target(grant, path);
          const [removed, remaining] = yield* sql
            .batch([
              sql`DELETE FROM secrets WHERE bucket = ${bucket} AND name = ${name} AND version = ${expectedVersion} RETURNING name`,
              sql`SELECT name FROM secrets WHERE bucket = ${bucket} AND name = ${name}`,
            ])
            .pipe(unavailable);
          if (removed.length) return;
          return yield* Effect.fail(
            remaining.length ? changed(path) : missingSecret(),
          );
        }),
    };
  });
}
