import { D1Client } from '@effect/sql-d1';
import {
  AlreadyHandled,
  BucketGrant,
  Expired,
  formatUserCode,
  GrantBucketNotFound,
  InvalidBucketGrant,
  InvalidMachineName,
  machineNameError,
  NoMatchingRequest,
  normalizeGrant,
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
import { unavailable } from './http-errors.ts';

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
  id: Schema.String,
  token_hash: Schema.String,
  machine_name: Schema.String,
  grant_json: Schema.String,
});
const MachineRow = Schema.Struct({
  id: Schema.String,
  machine_name: Schema.String,
  grant_json: Schema.fromJsonString(BucketGrant),
  created_at: Schema.Number,
  last_used_at: Schema.NullOr(Schema.Number),
});
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
  return Schema.decodeUnknownEffect(Schema.fromJsonString(BucketGrant))(
    row.grant_json,
  ).pipe(
    unavailable,
    Effect.map((grant) => ({ machine: row.machine_name, grant })),
  );
}
function requireAll(grant: BucketGrant) {
  return grant === 'all'
    ? Effect.void
    : Effect.fail(new HttpApiError.Forbidden());
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
  const authenticateToken = SqlSchema.findAll({
    Request: Schema.String,
    Result: TokenRow,
    execute: (hash) =>
      sql`UPDATE machine_tokens SET last_used_at=unixepoch('subsec')*1000 WHERE token_hash=${hash} RETURNING id, token_hash, machine_name, grant_json`,
  });
  const listRows = SqlSchema.findAll({
    Request: Schema.Void,
    Result: MachineRow,
    execute: () =>
      sql`SELECT id, machine_name, grant_json, created_at, last_used_at FROM machine_tokens ORDER BY created_at, id`,
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
      const [row] = yield* authenticateToken(hash).pipe(unavailable);
      if (!row) return yield* Effect.fail(new HttpApiError.Unauthorized());
      return row;
    });
  const handle = (
    code: string,
    status: 'approved' | 'denied',
    name: string | null,
    grant: BucketGrant,
  ) =>
    Effect.gen(function* () {
      const row = yield* lookup(code);
      const grantJson = JSON.stringify(normalizeGrant(grant));
      const chosenJson = JSON.stringify(grant);
      // Validate existence at the same atomic boundary that records the decision.
      const [updated, remaining] = yield* sql
        .batch([
          sql`UPDATE authorizations SET status=${status}, machine_name=${name}, grant_json=${grantJson} WHERE device_hash=${row.device_hash} AND status='pending' AND expires_at>unixepoch('subsec')*1000 AND (${chosenJson}='"all"' OR NOT EXISTS (SELECT 1 FROM json_each(${chosenJson}) root WHERE NOT EXISTS (SELECT 1 FROM buckets WHERE path=root.value))) RETURNING device_hash`,
          sql<RequestRow>`SELECT * FROM authorizations WHERE device_hash=${row.device_hash}`,
        ])
        .pipe(unavailable);
      if (!updated.length) {
        yield* requirePending(remaining[0]);
        return yield* Effect.fail(
          new GrantBucketNotFound({
            message: 'Some selected buckets no longer exist. Choose again.',
          }),
        );
      }
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
    approve: (code: string, name: string, grant: unknown) => {
      const message = machineNameError(name);
      return message
        ? Effect.fail(new InvalidMachineName({ message }))
        : Schema.decodeUnknownEffect(BucketGrant)(grant).pipe(
            Effect.mapError(
              () =>
                new InvalidBucketGrant({
                  message:
                    'Choose at least one existing bucket, or All buckets.',
                }),
            ),
            Effect.flatMap((grant) =>
              handle(code, 'approved', name.trim(), grant),
            ),
          );
    },
    deny: (code: string) =>
      handle(code, 'denied', null, 'all').pipe(
        Effect.catchTag('GrantBucketNotFound', () =>
          Effect.fail(new HttpApiError.ServiceUnavailable()),
        ),
      ),
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
            >`INSERT INTO machine_tokens(token_hash, machine_name, grant_json, created_at, id) SELECT ${tokenHash}, machine_name, grant_json, ${Date.now()}, ${crypto.randomUUID()} FROM authorizations WHERE device_hash=${deviceHash} AND status='approved' AND expires_at>unixepoch('subsec')*1000 RETURNING id, token_hash, machine_name, grant_json`,
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
    list: (grant: BucketGrant) =>
      Effect.gen(function* () {
        yield* requireAll(grant);
        const rows = yield* listRows().pipe(unavailable);
        return {
          machines: rows.map((row) => ({
            id: row.id,
            name: row.machine_name,
            grant: row.grant_json,
            approvedAt: new Date(row.created_at).toISOString(),
            lastUsedAt:
              row.last_used_at === null
                ? null
                : new Date(row.last_used_at).toISOString(),
          })),
        };
      }),
    revoke: (grant: BucketGrant, id: string) =>
      Effect.gen(function* () {
        yield* requireAll(grant);
        yield* sql
          .batch([sql`DELETE FROM machine_tokens WHERE id=${id}`])
          .pipe(unavailable);
      }),
    forAudit: (authorization: string) =>
      authenticated(authorization).pipe(
        Effect.flatMap((row) =>
          identity(row).pipe(
            Effect.map((result) => ({ ...result, id: row.id })),
          ),
        ),
      ),
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
