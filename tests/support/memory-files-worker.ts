import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
  R2Bucket,
  ScheduledController,
} from '@cloudflare/workers-types';
import { checkpointDatabase } from './vault-checkpoint-worker.ts';

type Env = { DB: D1Database; FILES: R2Bucket };
type Worker = {
  fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response>;
  scheduled(controller: ScheduledController, env: Env): Promise<void>;
};
async function checkpoint(label: string) {
  const result = await fetch(`https://nook-files-checkpoints.invalid${label}`);
  if (!result.ok) throw new Error('Synthetic attachment storage failure');
}
async function clock() {
  return (await (
    await fetch('https://nook-files-checkpoints.invalid/clock')
  ).json()) as number;
}
// Only the test wrapper substitutes SQLite wall time. Real SQL still executes
// against D1, including all guards, transactions, constraints and RETURNING.
function clockDatabase(db: D1Database, batchClockStepMs: number): D1Database {
  const statements = new WeakMap<
    D1PreparedStatement,
    { query: string; values: unknown[] }
  >();
  function native(query: string, values: unknown[], now: number) {
    return db
      .prepare(query.replace(/unixepoch\('subsec'\)/g, `(${now}/1000.0)`))
      .bind(...values);
  }
  function prepare(query: string, values: unknown[] = []): D1PreparedStatement {
    const statement: D1PreparedStatement = {
      bind: (...next) => prepare(query, next),
      all: async <T>() => native(query, values, await clock()).all<T>(),
      first: async <T>(column?: string) => {
        const statement = native(query, values, await clock());
        return column === undefined
          ? statement.first<T>()
          : statement.first<T>(column);
      },
      run: async <T>() => native(query, values, await clock()).run<T>(),
      raw: (async (options?: { columnNames?: boolean }) => {
        const statement = native(query, values, await clock());
        return options?.columnNames
          ? statement.raw({ columnNames: true })
          : statement.raw();
      }) as D1PreparedStatement['raw'],
    };
    statements.set(statement, { query, values });
    return statement;
  }
  return {
    prepare,
    async batch<T>(input: D1PreparedStatement[]) {
      const now = await clock();
      return db.batch<T>(
        input.map((statement, index) => {
          const source = statements.get(statement);
          return source
            ? native(
                source.query,
                source.values,
                now + index * batchClockStepMs,
              )
            : statement;
        }),
      );
    },
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
}
function objects(bucket: R2Bucket): R2Bucket {
  return new Proxy(bucket, {
    get(target, property) {
      if (property === 'put')
        return async (...args: Parameters<R2Bucket['put']>) => {
          await checkpoint('/r2/before-put');
          const result = await target.put(...args);
          await checkpoint('/r2/after-put');
          return result;
        };
      if (property === 'get')
        return async (...args: Parameters<R2Bucket['get']>) => {
          const object = await target.get(...args);
          await checkpoint('/r2/after-get');
          if (!object || !('body' in object)) return object;
          const body = new Proxy(object.body, {
            get(stream, key) {
              if (key === 'cancel')
                return async () => {
                  await checkpoint('/r2/cancel');
                  await stream.cancel();
                };
              const value = Reflect.get(stream, key);
              return typeof value === 'function' ? value.bind(stream) : value;
            },
          });
          return new Proxy(object, {
            get(value, key) {
              return key === 'body' ? body : Reflect.get(value, key);
            },
          });
        };
      if (property === 'list')
        return async (options?: Parameters<R2Bucket['list']>[0]) => {
          const result = await fetch(
            `https://nook-files-checkpoints.invalid/r2/list${options?.cursor ? '-cursor' : ''}`,
          );
          if (!result.ok) throw new Error('Invalid R2 cursor (synthetic)');
          return target.list(options);
        };
      if (property === 'delete')
        return async (keys: string | string[]) => {
          await checkpoint('/r2/before-delete');
          await target.delete(keys);
          await checkpoint('/r2/after-delete');
        };
      const value = Reflect.get(target, property);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
async function environment(env: Env, batchClockStepMs: number) {
  const now = await clock();
  return {
    ...env,
    DB: checkpointDatabase(clockDatabase(env.DB, batchClockStepMs), true, true),
    FILES: objects(env.FILES),
    // Expected production seam: a synchronous clock, supplied only by tests.
    // Production defaults to Date.now; the seam must also reach Cron's sweep.
    FILE_CLOCK: { now: () => now },
  };
}
export function memoryFilesWorker(
  worker: Worker,
  options: { batchClockStepMs?: number } = {},
) {
  return {
    async fetch(request: Request, env: Env, ctx: ExecutionContext) {
      const wrapped = await environment(env, options.batchClockStepMs ?? 0);
      if (new URL(request.url).pathname === '/api/__test/files-sweep') {
        await worker.scheduled(
          { scheduledTime: await clock(), cron: '* * * * *', noRetry() {} },
          wrapped,
        );
        return new Response(null, { status: 204 });
      }
      return worker.fetch(request, wrapped, ctx);
    },
  };
}
