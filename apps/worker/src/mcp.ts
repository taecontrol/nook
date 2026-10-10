import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  Bucket,
  BucketPath,
  CreatedBucket,
  Memory,
  type MemoryClient,
  type Principal,
  Remember,
  Remembered,
  Secret,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import type { BucketGrant } from './authorization.ts';
import { bucketOperations } from './buckets.ts';
import { memoryStore } from './memory.ts';
import { machineVault } from './vault.ts';

function standard<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
}
const NoInput = standard(Schema.Struct({}));
// As in the API, bucketOperations owns path validation and its exact messages.
const PathInput = standard(Schema.Struct({ path: Schema.String }));
const ListOutput = standard(Schema.Struct({ buckets: Schema.Array(Bucket) }));
const CreateOutput = standard(CreatedBucket);
const DeleteOutput = standard(Schema.Struct({ path: BucketPath }));
const SecretInput = standard(Schema.Struct({ bucket: Schema.String }));
const SecretsOutput = standard(
  Schema.Struct({ secrets: Schema.Array(Secret) }),
);

type Store = Effect.Success<typeof bucketOperations>;
type BucketError = Effect.Error<ReturnType<Store['create'] | Store['delete']>>;
type VaultStore = Effect.Success<ReturnType<typeof machineVault>>;
type VaultError = Effect.Error<ReturnType<VaultStore['list']>>;
type MemoryStore = Effect.Success<ReturnType<typeof memoryStore>>;
type MemoryError = Effect.Error<
  ReturnType<MemoryStore['remember'] | MemoryStore['get']>
>;
const unavailableMessage = 'Service unavailable. Try again later.';
function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}
function failure(error: BucketError | VaultError | MemoryError) {
  if (error._tag === 'Forbidden')
    return errorResult('Access to this bucket is forbidden.');
  if (error._tag === 'ServiceUnavailable')
    return errorResult(unavailableMessage);
  return errorResult(error.message);
}
function success(body: Record<string, unknown>) {
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    structuredContent: body,
  };
}

function clientString(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function envelopeClient(envelope: unknown): MemoryClient | undefined {
  if (!isRecord(envelope)) return;
  const value = envelope['io.modelcontextprotocol/clientInfo'];
  if (!isRecord(value)) return;
  const { name, version } = value;
  if (!clientString(name, 128)) return;
  if (version !== undefined && !clientString(version, 64)) return;
  return { name, version: version === undefined ? null : (version as string) };
}
function userAgentClient(userAgent: string | null): MemoryClient | undefined {
  if (!userAgent || /\p{Cc}/u.test(userAgent)) return;
  const first = userAgent.split(' ')[0];
  const match =
    /^([!#$%&'*+.^_`|~0-9a-z-]+)(?:\/([!#$%&'*+.^_`|~0-9a-z-]+))?$/i.exec(
      first,
    );
  if (!match || !clientString(match[1], 128)) return;
  if (match[2] !== undefined && !clientString(match[2], 64)) return;
  return { name: match[1], version: match[2] ?? null };
}
function clientFrom(envelope: unknown, userAgent: string | null): MemoryClient {
  return (
    envelopeClient(envelope) ??
    userAgentClient(userAgent) ?? { name: 'unknown', version: null }
  );
}

export function mcpHandler(
  db: D1Database,
  caller: { grant: BucketGrant; principal: Principal },
) {
  const { grant, principal } = caller;
  function execute<A extends Record<string, unknown>>(
    operation: Effect.Effect<
      A,
      BucketError | VaultError | MemoryError,
      D1Client.D1Client
    >,
  ) {
    return Effect.runPromise(
      operation.pipe(
        Effect.match({ onSuccess: success, onFailure: failure }),
        Effect.provide(D1Client.layer({ db })),
        Effect.catchCause(() =>
          Effect.succeed(errorResult(unavailableMessage)),
        ),
      ),
    );
  }
  function run<A extends Record<string, unknown>>(
    operation: (store: Store) => Effect.Effect<A, BucketError>,
  ) {
    return execute(bucketOperations.pipe(Effect.flatMap(operation)));
  }
  return createMcpHandler(({ requestInfo }) => {
    const server = new McpServer({ name: 'nook', version: '1.0.0' });
    const userAgent = requestInfo?.headers.get('User-Agent') ?? null;
    server.registerTool(
      'remember',
      {
        description:
          'Store Markdown content in a bucket, with up to 10 optional lowercase tags. Name the bucket explicitly; ask the owner when unsure which bucket applies. Optionally pass the absolute workingDirectory. Identical current content in the same bucket returns created: false with the original tags and changes nothing. Retrying after a failure or lost response is safe.',
        inputSchema: standard(Remember),
        outputSchema: standard(Remembered),
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      (input, ctx) =>
        execute(
          memoryStore(grant).pipe(
            Effect.flatMap((store) =>
              store.remember(
                principal,
                clientFrom(ctx.mcpReq.envelope, userAgent),
                input,
              ),
            ),
          ),
        ),
    );
    server.registerTool(
      'get',
      {
        description:
          'Read a memory by its id, including exact Markdown content, tags, and provenance. The id determines its bucket and the caller must have read access. When storing memories, name the bucket explicitly and ask the owner when unsure; retrying remember with identical content is safe.',
        inputSchema: standard(Schema.Struct({ id: Schema.String })),
        outputSchema: standard(Memory),
        annotations: { readOnlyHint: true },
      },
      ({ id }) =>
        execute(
          memoryStore(grant).pipe(Effect.flatMap((store) => store.get(id))),
        ),
    );
    server.registerTool(
      'list_secrets',
      {
        description:
          'List names and descriptions of secrets in the bucket and its ancestors, never values. Use nook run --secret ENV=bucket/NAME --purpose "…" -- <command> instead of asking the owner for a value. When the project has a nook.json, its mapped secrets are injected without --secret. Store a new value with nook vault create <bucket>/<NAME> --purpose "…", piped on stdin instead of pasting it into the conversation. Existing names cannot be overwritten.',
        inputSchema: SecretInput,
        outputSchema: SecretsOutput,
        annotations: { readOnlyHint: true },
      },
      ({ bucket }) =>
        execute(
          machineVault(grant).pipe(
            Effect.flatMap((store) => store.list(bucket)),
          ),
        ),
    );
    server.registerTool(
      'list_buckets',
      {
        description:
          'List the visible buckets. Buckets are paths such as work/acme; every Nook operation names its bucket explicitly.',
        inputSchema: NoInput,
        outputSchema: ListOutput,
        annotations: { readOnlyHint: true },
      },
      () => run((store) => store.list(grant)),
    );
    server.registerTool(
      'create_bucket',
      {
        description:
          'Create a bucket and any missing ancestors. This operation is idempotent. Ask the owner which bucket applies when you do not know, and get their confirmation before creating one.',
        inputSchema: PathInput,
        outputSchema: CreateOutput,
        annotations: {
          readOnlyHint: false,
          destructiveHint: false,
          idempotentHint: true,
        },
      },
      ({ path }) => run((store) => store.create(grant, path)),
    );
    server.registerTool(
      'delete_bucket',
      {
        description:
          'Delete an empty bucket to correct a mistaken creation. The me bucket and buckets with children, secrets, or memories cannot be deleted. Confirm with the owner before deleting.',
        inputSchema: PathInput,
        outputSchema: DeleteOutput,
        annotations: { destructiveHint: true, idempotentHint: false },
      },
      ({ path }) =>
        run((store) => store.delete(grant, path).pipe(Effect.as({ path }))),
    );
    return server;
  });
}
