import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import {
  Bucket,
  type BucketGrant,
  BucketPath,
  CreatedBucket,
  Detached,
  DetachFile,
  ForgetMemory,
  Forgotten,
  McpMemory,
  MemorySearchResults,
  type Principal,
  Remember,
  Remembered,
  SearchMemories,
  Secret,
  Updated,
  UpdateMemory,
} from '@nook/contract';
import { Effect, Schema } from 'effect';
import { bucketOperations } from './buckets.ts';
import { clientFrom } from './client-provenance.ts';
import type { FileBindings } from './file-objects.ts';
import { memoryStore } from './memory.ts';
import { memoryFiles } from './memory-files.ts';
import type { MemoryIndex } from './memory-index.ts';
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
type FileStore = Effect.Success<ReturnType<typeof memoryFiles>>;
type FileError = Effect.Error<ReturnType<FileStore['detach']>>;
type MemoryError = Effect.Error<
  ReturnType<
    | MemoryStore['remember']
    | MemoryStore['update']
    | MemoryStore['forget']
    | MemoryStore['get']
    | MemoryStore['search']
  >
>;
const unavailableMessage = 'Service unavailable. Try again later.';
// Discovery advertises a positive integer. The store owns invalid-version
// wording, including missing keys and wrong primitive types.
function versionInput<
  Fields extends Readonly<
    Record<string, Schema.ConstraintDecoder<unknown> & Schema.Top>
  >,
>(schema: Schema.Struct<Fields>) {
  const advertised = standard(schema);
  const boundary = standard(
    schema.mapFields((fields) => ({
      ...fields,
      expectedVersion: Schema.optionalKey(Schema.Unknown),
    })),
  );
  return {
    ...advertised,
    '~standard': {
      ...advertised['~standard'],
      validate: boundary['~standard'].validate,
    },
  };
}
function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}
function failure(error: BucketError | VaultError | MemoryError | FileError) {
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

export function mcpHandler(
  db: D1Database,
  caller: { grant: BucketGrant; principal: Principal },
  options: {
    index?: MemoryIndex;
    waitUntil?: (promise: Promise<unknown>) => void;
    files?: FileBindings;
  } = {},
) {
  const { grant, principal } = caller;
  function execute<A extends Record<string, unknown>>(
    operation: Effect.Effect<
      A,
      BucketError | VaultError | MemoryError | FileError,
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
    const memories = memoryStore(
      grant,
      options.index,
      options.waitUntil,
      options.files,
    );
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
          memories.pipe(
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
      'forget',
      {
        description:
          'Permanently delete a memory, all versions and attached files, including its keyword and meaning search entries. Pass the version from get as expectedVersion. If it changed, get it again before forgetting. After a lost response, Memory not found on a retry means it is already gone.',
        inputSchema: versionInput(ForgetMemory),
        outputSchema: standard(Forgotten),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      (input, ctx) =>
        execute(
          memories.pipe(
            Effect.flatMap((store) =>
              store.forget(input, false, {
                principal,
                client: clientFrom(ctx.mcpReq.envelope, userAgent),
              }),
            ),
          ),
        ),
    );
    server.registerTool(
      'update',
      {
        description:
          'Replace a memory by creating an immutable version. Pass the version from get as expectedVersion. Omitted tags are kept; [] clears them. Optionally report an absolute workingDirectory. A duplicate names the other memory in this bucket. Retrying identical input after a failure or lost response is safe and returns updated: false when content and resulting tags already match. It can answer changed after another writer intervenes; get again before choosing a new update.',
        inputSchema: versionInput(UpdateMemory),
        outputSchema: standard(Updated),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: true,
        },
      },
      (input, ctx) =>
        execute(
          memories.pipe(
            Effect.flatMap((store) =>
              store.update(
                principal,
                clientFrom(ctx.mcpReq.envelope, userAgent),
                input,
              ),
            ),
          ),
        ),
    );
    server.registerTool(
      'search',
      {
        description:
          'Find up to 10 memories by keyword or meaning in a bucket, its ancestors, and me, within your grant. Name the bucket explicitly; ask the owner when unsure. An optional tags filter requires every tag. Results contain a title and snippet; call get with an id for the full content. If meaning search is unavailable, keyword results may be incomplete.',
        inputSchema: standard(SearchMemories),
        outputSchema: standard(MemorySearchResults),
        annotations: { readOnlyHint: true },
      },
      ({ bucket, query, tags }) =>
        execute(
          memories.pipe(
            Effect.flatMap((store) =>
              store.search(bucket, query, tags, 'inherited', 10),
            ),
            Effect.map(({ results, meaning }) => ({
              results: results.map(
                ({
                  id,
                  bucket,
                  title,
                  tags,
                  snippet,
                  match,
                  files,
                  fileCount,
                }) => ({
                  id,
                  bucket,
                  title,
                  tags,
                  snippet,
                  match,
                  files,
                  fileCount,
                }),
              ),
              meaning,
            })),
          ),
        ).then((result) => {
          if (
            'structuredContent' in result &&
            result.structuredContent.meaning === 'unavailable'
          )
            result.content.push({
              type: 'text',
              text: 'Meaning search is unavailable; results may be incomplete.',
            });
          return result;
        }),
    );
    server.registerTool(
      'get',
      {
        description:
          'Read a memory by its id, including exact Markdown content, tags, and provenance. The id determines its bucket and the caller must have read access. When storing memories, name the bucket explicitly and ask the owner when unsure; retrying remember with identical content is safe. Attach files with nook memory attach <id> <path>; download bytes with nook memory download <id> <name> [--output <path>]. To remove a file, call detach with its name and sha256 from get.',
        inputSchema: standard(Schema.Struct({ id: Schema.String })),
        outputSchema: standard(McpMemory),
        annotations: { readOnlyHint: true },
      },
      ({ id }) =>
        execute(
          memories.pipe(
            Effect.flatMap((store) => store.get(id)),
            Effect.map(({ files, ...memory }) => ({
              ...memory,
              files: files.map(({ name, mediaType, size, sha256 }) => ({
                name,
                mediaType,
                size,
                sha256,
              })),
            })),
          ),
        ),
    );
    server.registerTool(
      'detach',
      {
        description:
          'Permanently remove a file from a memory. Pass its name and sha256 from get. If it changed, get the memory again before choosing to detach it. A retry after success answers File not found.',
        inputSchema: standard(DetachFile),
        outputSchema: standard(Detached),
        annotations: {
          readOnlyHint: false,
          destructiveHint: true,
          idempotentHint: false,
        },
      },
      (input, ctx) =>
        execute(
          memoryFiles(grant, options.files).pipe(
            Effect.flatMap((store) =>
              store.detach(
                {
                  principal,
                  client: clientFrom(ctx.mcpReq.envelope, userAgent),
                },
                input,
              ),
            ),
          ),
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
