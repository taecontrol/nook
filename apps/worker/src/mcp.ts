import type { D1Database } from '@cloudflare/workers-types';
import { D1Client } from '@effect/sql-d1';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { Bucket, BucketPath, CreatedBucket } from '@nook/contract';
import { Effect, Schema } from 'effect';
import type { BucketGrant } from './authorization.ts';
import { bucketOperations } from './buckets.ts';

function standard<S extends Schema.ConstraintDecoder<unknown>>(schema: S) {
  return Schema.toStandardJSONSchemaV1(Schema.toStandardSchemaV1(schema));
}
const NoInput = standard(Schema.Struct({}));
// As in the API, bucketOperations owns path validation and its exact messages.
const PathInput = standard(Schema.Struct({ path: Schema.String }));
const ListOutput = standard(Schema.Struct({ buckets: Schema.Array(Bucket) }));
const CreateOutput = standard(CreatedBucket);
const DeleteOutput = standard(Schema.Struct({ path: BucketPath }));

type Store = Effect.Success<typeof bucketOperations>;
type BucketError = Effect.Error<ReturnType<Store['create'] | Store['delete']>>;
const unavailableMessage = 'Service unavailable. Try again later.';
function errorResult(message: string) {
  return { isError: true, content: [{ type: 'text' as const, text: message }] };
}
function failure(error: BucketError) {
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

export function mcpHandler(db: D1Database, grant: BucketGrant) {
  function run<A extends Record<string, unknown>>(
    operation: (store: Store) => Effect.Effect<A, BucketError>,
  ) {
    return Effect.runPromise(
      bucketOperations.pipe(
        Effect.flatMap(operation),
        Effect.match({ onSuccess: success, onFailure: failure }),
        Effect.provide(D1Client.layer({ db })),
        Effect.catchCause(() =>
          Effect.succeed(errorResult(unavailableMessage)),
        ),
      ),
    );
  }
  return createMcpHandler(() => {
    const server = new McpServer({ name: 'nook', version: '1.0.0' });
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
          'Delete an empty bucket to correct a mistaken creation. The me bucket and buckets with children cannot be deleted. Confirm with the owner before deleting.',
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
