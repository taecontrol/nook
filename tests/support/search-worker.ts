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
function tablesNamedBy(sql: string) {
  return [
    ...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE)\s+(?!SET\b)(\w+)/gi),
  ].map((match) => match[1]);
}
function observedDatabase(db: D1Database): D1Database {
  const originals = new WeakMap<
    D1PreparedStatement,
    { statement: D1PreparedStatement; tables: string[] }
  >();
  const trip = (tables: string[]) =>
    fetch('https://nook-search-fixture.invalid/d1', {
      method: 'POST',
      body: JSON.stringify([...new Set(tables)]),
    });
  function wrap(
    statement: D1PreparedStatement,
    tables: string[],
  ): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...args) => wrap(statement.bind(...args), tables),
      async all<T>() {
        await trip(tables);
        return statement.all<T>();
      },
      async run<T>() {
        await trip(tables);
        return statement.run<T>();
      },
      first: statement.first.bind(statement),
      raw: statement.raw.bind(statement),
    };
    originals.set(wrapped, { statement, tables });
    return wrapped;
  }
  return {
    prepare: (sql) => wrap(db.prepare(sql), tablesNamedBy(sql)),
    async batch<T>(statements: D1PreparedStatement[]) {
      const observed = statements.map(
        (s) => originals.get(s) ?? { statement: s, tables: [] },
      );
      await trip(observed.flatMap((o) => o.tables));
      return db.batch<T>(observed.map((o) => o.statement));
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
    fetch(request: Request, env: { DB: D1Database }, ctx: ExecutionContext) {
      const url = new URL(request.url);
      if (url.pathname === '/api/__test/stderr-marker') {
        console.error(url.searchParams.get('marker'));
        return new Response(null, { status: 204 });
      }
      return worker.fetch(request, bindings(env), ctx);
    },
    scheduled: (
      controller: ScheduledController,
      env: { DB: D1Database },
      ctx: ExecutionContext,
    ) => worker.scheduled?.(controller, bindings(env), ctx),
  };
}
