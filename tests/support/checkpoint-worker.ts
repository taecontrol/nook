import type {
  D1Database,
  D1PreparedStatement,
} from '@cloudflare/workers-types';

type Worker = {
  fetch(request: Request, env: { DB: D1Database }): Promise<Response>;
};
function checkpoint(category: string, stage: string) {
  // The observer receives labels only, never SQL, bindings, rows, or credentials.
  return fetch(`https://nook-test-checkpoints.invalid/${category}-${stage}`);
}
function database(db: D1Database, category: string): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(
    statement: D1PreparedStatement,
    read: boolean,
  ): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values), read),
      async all<T>() {
        const result = await statement.all<T>();
        await checkpoint(category, read ? 'read' : 'write');
        return result;
      },
      first: statement.first.bind(statement),
      raw: statement.raw.bind(statement),
      run: statement.run.bind(statement),
    };
    originals.set(wrapped, statement);
    return wrapped;
  }
  return {
    prepare: (query) =>
      wrap(db.prepare(query), /^SELECT\b/i.test(query.trim())),
    async batch<T>(statements: D1PreparedStatement[]) {
      await checkpoint(category, 'before-batch');
      const result = await db.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      await checkpoint(category, 'batch');
      await checkpoint(category, 'write');
      return result;
    },
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
}
export function checkpointWorker(worker: Worker) {
  return {
    fetch(request: Request, env: { DB: D1Database }) {
      const path = new URL(request.url).pathname;
      const category = path.startsWith('/api/authorizations/')
        ? 'owner'
        : path === '/api/machine/token' && request.method === 'POST'
          ? 'poll'
          : 'machine';
      return worker.fetch(request, { ...env, DB: database(env.DB, category) });
    },
  };
}
