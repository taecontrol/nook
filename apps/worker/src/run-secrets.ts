import { D1Client } from '@effect/sql-d1';
import {
  InvalidRun,
  type RunSecrets,
  SecretKeyUnavailable,
  SecretNotFound,
  SecretsForbidden,
  splitSecretPath,
  validateRunSecrets,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { type AuditMachine, auditStore } from './audit.ts';
import { canRead } from './authorization.ts';
import { open, parseKeyring } from './vault-keyring.ts';

const Envelope = Schema.Struct({
  key_id: Schema.String,
  iv: Schema.String,
  ciphertext: Schema.String,
});
export function runSecrets(
  machine: AuditMachine,
  input: RunSecrets,
  binding: string,
) {
  return Effect.gen(function* () {
    const invalid = validateRunSecrets(input);
    if (invalid)
      return yield* Effect.fail(new InvalidRun({ message: invalid }));
    const paths = [...new Set(input.secrets)];
    const audit = yield* auditStore;
    const denied = paths.filter(
      (path) => !canRead(machine.grant, splitSecretPath(path).bucket),
    );
    if (denied.length) {
      yield* audit.record(machine, input, denied, 'denied');
      return yield* Effect.fail(new SecretsForbidden({ paths: denied }));
    }
    const sql = yield* D1Client.D1Client;
    const rows = yield* sql
      .batch(
        paths.map((path) => {
          const { bucket, name } = splitSecretPath(path);
          return sql`SELECT key_id, iv, ciphertext FROM secrets WHERE bucket=${bucket} AND name=${name}`;
        }),
      )
      .pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable()));
    const values = yield* decrypt(paths, rows, binding);
    yield* audit.record(machine, input, paths, 'delivered');
    return { values };
  });
}
function decrypt(
  paths: string[],
  rows: readonly (readonly unknown[])[],
  binding: string,
) {
  return Effect.gen(function* () {
    const missing = paths.find((_, index) => rows[index].length === 0);
    if (missing)
      return yield* Effect.fail(
        new SecretNotFound({ message: `${missing} was not found.` }),
      );
    const ring = yield* parseKeyring(binding);
    return yield* Effect.forEach(paths, (path, index) =>
      Effect.gen(function* () {
        const envelope = yield* Schema.decodeUnknownEffect(Envelope)(
          rows[index][0],
        ).pipe(Effect.mapError(() => new HttpApiError.ServiceUnavailable()));
        const value = yield* open(ring, path, envelope).pipe(
          Effect.mapError(
            () =>
              new SecretKeyUnavailable({
                message: `Cannot open a secret encrypted with key ${envelope.key_id}.`,
              }),
          ),
        );
        return { path, value };
      }),
    );
  });
}
