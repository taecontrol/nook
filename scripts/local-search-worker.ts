import type {
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';

type LocalEnvironment = Record<string, unknown> & {
  NOOK_LOCAL_SEARCH: { fetch(request: Request): Promise<Response> };
};
type Worker = {
  fetch(
    request: Request,
    env: LocalEnvironment,
    ctx: ExecutionContext,
  ): Promise<Response>;
  scheduled?(
    controller: ScheduledController,
    env: LocalEnvironment,
    ctx: ExecutionContext,
  ): unknown;
};

// This decorator enters only the local Miniflare bundle. The deployed Worker
// receives the native AI and Vectorize bindings from wrangler.jsonc.
export function localSearchWorker(worker: Worker) {
  function bindings(env: LocalEnvironment) {
    async function invoke(method: string, ...args: unknown[]) {
      const response = await env.NOOK_LOCAL_SEARCH.fetch(
        new Request(`https://nook-search-fixture.invalid/${method}`, {
          method: 'POST',
          body: JSON.stringify(args),
        }),
      );
      if (!response.ok) throw new Error('Local search service unavailable.');
      return response.json();
    }
    return {
      ...env,
      AI: {
        run: (model: string, input: unknown) => invoke('run', model, input),
      },
      MEMORY_INDEX: {
        query: (values: number[], options: unknown) =>
          invoke('query', values, options),
        upsert: (vectors: unknown) => invoke('upsert', vectors),
      },
    };
  }
  return {
    fetch: (request: Request, env: LocalEnvironment, ctx: ExecutionContext) =>
      worker.fetch(request, bindings(env), ctx),
    scheduled: (
      controller: ScheduledController,
      env: LocalEnvironment,
      ctx: ExecutionContext,
    ) => worker.scheduled?.(controller, bindings(env), ctx),
  };
}
