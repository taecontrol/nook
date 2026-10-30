import type {
  D1Database,
  D1PreparedStatement,
  ExecutionContext,
  ScheduledController,
} from '@cloudflare/workers-types';

async function invoke(method: string, ...args: unknown[]) {
  const response = await fetch(
    `https://nook-search-fixture.invalid/${method}`,
    { method: 'POST', body: JSON.stringify(args) },
  );
  if (!response.ok) throw new Error(await response.text());
  return response.json();
}
function observedDatabase(db: D1Database): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  const trip = () => fetch('https://nook-search-fixture.invalid/d1');
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...args) => wrap(statement.bind(...args)),
      async all<T>() {
        await trip();
        return statement.all<T>();
      },
      async run<T>() {
        await trip();
        return statement.run<T>();
      },
      first: statement.first.bind(statement),
      raw: statement.raw.bind(statement),
    };
    originals.set(wrapped, statement);
    return wrapped;
  }
  return {
    prepare: (sql) => wrap(db.prepare(sql)),
    async batch<T>(statements: D1PreparedStatement[]) {
      await trip();
      return db.batch<T>(statements.map((s) => originals.get(s) ?? s));
    },
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
}
export function searchWorker(worker: {
  fetch(
    request: Request,
    env: { DB: D1Database },
    ctx?: ExecutionContext,
  ): Promise<Response>;
  scheduled?: (
    controller: ScheduledController,
    env: { DB: D1Database },
    ctx: ExecutionContext,
  ) => unknown;
}) {
  const bindings = (env: { DB: D1Database }) => ({
    ...env,
    DB: observedDatabase(env.DB),
    AI: { run: (model: string, input: unknown) => invoke('run', model, input) },
    MEMORY_INDEX: {
      query: (values: number[], options: unknown) =>
        invoke('query', values, options),
      upsert: (vectors: unknown) => invoke('upsert', vectors),
      getByIds: (ids: string[]) => invoke('getByIds', ids),
      deleteByIds: (ids: string[]) => invoke('deleteByIds', ids),
    },
  });
  return {
    fetch: (request: Request, env: { DB: D1Database }, ctx: ExecutionContext) =>
      worker.fetch(request, bindings(env), ctx),
    scheduled: (
      controller: ScheduledController,
      env: { DB: D1Database },
      ctx: ExecutionContext,
    ) => worker.scheduled?.(controller, bindings(env), ctx),
  };
}
