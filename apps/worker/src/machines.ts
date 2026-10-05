import { D1Client } from '@effect/sql-d1';
import {
  AlreadyHandled,
  BucketGrant,
  Expired,
  formatUserCode,
  InvalidMachineName,
  machineNameError,
  NoMatchingRequest,
  normalizeUserCode,
  PendingLimit,
  PollDenied,
  PollExpired,
  PollInvalid,
  PollPending,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { HttpApiError } from 'effect/http-api';
import { SqlSchema } from 'effect/sql';

const RequestRow = Schema.Struct({
  device_hash: Schema.String,
  user_code: Schema.String,
  suggested_name: Schema.String,
  client: Schema.String,
  machine_name: Schema.NullOr(Schema.String),
  grant_json: Schema.String,
  status: Schema.Literals(['pending', 'approved', 'denied']),
  requested_at: Schema.Number,
  expires_at: Schema.Number,
});
type RequestRow = typeof RequestRow.Type;
const TokenRow = Schema.Struct({
  token_hash: Schema.String,
  machine_name: Schema.String,
  grant_json: Schema.String,
});
const unavailable = Effect.mapError(
  () => new HttpApiError.ServiceUnavailable(),
);
export function randomCode() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function userCode() {
  const alphabet = 'BCDFGHJKLMNPQRSTVWXZ';
  // Rejection sampling avoids modulo bias in the RFC 8628 alphabet.
  let result = '';
  while (result.length < 8) {
    for (const byte of crypto.getRandomValues(new Uint8Array(16))) {
      if (byte < 256 - (256 % alphabet.length) && result.length < 8)
        result += alphabet[byte % alphabet.length];
    }
  }
  return formatUserCode(result);
}
export function hashCode(value: string) {
  return Effect.promise(async () =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)),
      ),
      (byte) => byte.toString(16).padStart(2, '0'),
    ).join(''),
  );
}
function requirePending(
  row: RequestRow | undefined,
): Effect.Effect<RequestRow, NoMatchingRequest | Expired | AlreadyHandled> {
  if (!row) return Effect.fail(new NoMatchingRequest());
  if (row.expires_at <= Date.now()) return Effect.fail(new Expired());
  if (row.status !== 'pending') return Effect.fail(new AlreadyHandled());
  return Effect.succeed(row);
}
function pollState(
  row: RequestRow | undefined,
): Effect.Effect<void, PollInvalid | PollExpired | PollPending | PollDenied> {
  if (!row) return Effect.fail(new PollInvalid());
  if (row.expires_at <= Date.now()) return Effect.fail(new PollExpired());
  if (row.status === 'pending') return Effect.fail(new PollPending());
  if (row.status === 'denied') return Effect.fail(new PollDenied());
  return Effect.void;
}
function identity(row: typeof TokenRow.Type) {
  return Schema.decodeUnknownEffect(BucketGrant)(
    JSON.parse(row.grant_json),
  ).pipe(
    unavailable,
    Effect.map((grant) => ({ machine: row.machine_name, grant })),
  );
}
export const machineOperations = Effect.gen(function* () {
  const sql = yield* D1Client.D1Client;
  const findCode = SqlSchema.findAll({
    Request: Schema.String,
    Result: RequestRow,
    execute: (code) =>
      sql`SELECT * FROM authorizations WHERE user_code=${formatUserCode(normalizeUserCode(code))}`,
  });
  const findDevice = SqlSchema.findAll({
    Request: Schema.String,
    Result: RequestRow,
    execute: (hash) =>
      sql`SELECT * FROM authorizations WHERE device_hash=${hash}`,
  });
  const findToken = SqlSchema.findAll({
    Request: Schema.String,
    Result: TokenRow,
    execute: (hash) =>
      sql`SELECT token_hash, machine_name, grant_json FROM machine_tokens WHERE token_hash=${hash}`,
  });
  const lookup = (code: string) =>
    findCode(code).pipe(
      unavailable,
      Effect.flatMap((rows) => requirePending(rows[0])),
    );
  const authenticated = (authorization: string) =>
    Effect.gen(function* () {
      const token = /^Bearer (nook_[A-Za-z0-9_-]{43})$/.exec(
        authorization,
      )?.[1];
      if (!token) return yield* Effect.fail(new HttpApiError.Unauthorized());
      const hash = yield* hashCode(token);
      const [row] = yield* findToken(hash).pipe(unavailable);
      if (!row) return yield* Effect.fail(new HttpApiError.Unauthorized());
      return row;
    });
  const handle = (
    code: string,
    status: 'approved' | 'denied',
    name: string | null,
  ) =>
    Effect.gen(function* () {
      const row = yield* lookup(code);
      const [updated] = yield* sql
        .batch([
          sql`UPDATE authorizations SET status=${status}, machine_name=${name} WHERE device_hash=${row.device_hash} AND status='pending' AND expires_at>unixepoch('subsec')*1000 RETURNING device_hash`,
        ])
        .pipe(unavailable);
      if (!updated.length)
        return yield* Effect.fail(
          row.expires_at <= Date.now() ? new Expired() : new AlreadyHandled(),
        );
    });
  return {
    create: (origin: string, suggestedName: string, client: string) =>
      Effect.gen(function* () {
        const now = Date.now();
        const deviceCode = randomCode();
        const hash = yield* hashCode(deviceCode);
        const code = userCode();
        const [, inserted] = yield* sql
          .batch([
            sql`DELETE FROM authorizations WHERE expires_at<=unixepoch('subsec')*1000`,
            sql`INSERT INTO authorizations(device_hash, user_code, suggested_name, client, requested_at, expires_at) SELECT ${hash}, ${code}, ${suggestedName}, ${client}, ${now}, ${now + 600_000} WHERE (SELECT count(*) FROM authorizations WHERE status='pending' AND expires_at>unixepoch('subsec')*1000)<20 RETURNING user_code`,
          ])
          .pipe(unavailable);
        if (!inserted.length) return yield* Effect.fail(new PendingLimit());
        return {
          deviceCode,
          userCode: code,
          verificationUrl: `${origin}/cli/authorize`,
          expiresIn: 600,
          interval: 2,
        };
      }),
    lookup: (code: string) =>
      lookup(code).pipe(
        Effect.map((row) => ({
          suggestedName: row.suggested_name,
          client: row.client,
          requestedAt: new Date(row.requested_at).toISOString(),
          expiresAt: new Date(row.expires_at).toISOString(),
        })),
      ),
    approve: (code: string, name: string) => {
      const message = machineNameError(name);
      return message
        ? Effect.fail(new InvalidMachineName({ message }))
        : handle(code, 'approved', name.trim());
    },
    deny: (code: string) => handle(code, 'denied', null),
    poll: (deviceCode: string) =>
      Effect.gen(function* () {
        const deviceHash = yield* hashCode(deviceCode);
        const [row] = yield* findDevice(deviceHash).pipe(unavailable);
        yield* pollState(row);
        const token = `nook_${randomCode()}`;
        const tokenHash = yield* hashCode(token);
        const [inserted] = yield* sql
          .batch([
            sql<
              typeof TokenRow.Type
            >`INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at) SELECT ${tokenHash}, machine_name, grant_json, ${Date.now()} FROM authorizations WHERE device_hash=${deviceHash} AND status='approved' AND expires_at>unixepoch('subsec')*1000 RETURNING token_hash, machine_name, grant_json`,
            sql`DELETE FROM authorizations WHERE device_hash=${deviceHash} AND EXISTS (SELECT 1 FROM machine_tokens WHERE token_hash=${tokenHash})`,
          ])
          .pipe(unavailable);
        if (!inserted.length)
          return yield* Effect.fail(
            row.expires_at <= Date.now()
              ? new PollExpired()
              : new PollInvalid(),
          );
        return { token, ...(yield* identity(inserted[0])) };
      }),
    whoami: (authorization: string) =>
      authenticated(authorization).pipe(Effect.flatMap(identity)),
    logout: (authorization: string) =>
      authenticated(authorization).pipe(
        Effect.flatMap((row) =>
          sql
            .batch([
              sql`DELETE FROM machine_tokens WHERE token_hash=${row.token_hash}`,
            ])
            .pipe(unavailable, Effect.asVoid),
        ),
      ),
  };
});
