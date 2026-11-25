import type {
  D1Database,
  ExecutionContext,
  R2Bucket,
  ScheduledController,
} from '@cloudflare/workers-types';
import { clockDatabase } from './d1-clock.ts';
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
    DB: checkpointDatabase(
      clockDatabase(env.DB, clock, batchClockStepMs),
      true,
      true,
    ),
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
