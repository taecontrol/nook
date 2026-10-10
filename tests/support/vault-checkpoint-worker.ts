import type {
  D1Database,
  D1PreparedStatement,
} from '@cloudflare/workers-types';

async function checkpoint(stage: string) {
  const result = await fetch(`https://nook-vault-checkpoints.invalid/${stage}`);
  if (!result.ok) throw new Error('Synthetic D1 failure');
}
function decorate(
  db: D1Database,
  observeStatements: boolean,
  observeBatchSize: boolean,
): D1Database {
  const originals = new WeakMap<D1PreparedStatement, D1PreparedStatement>();
  function wrap(statement: D1PreparedStatement): D1PreparedStatement {
    const wrapped: D1PreparedStatement = {
      bind: (...values) => wrap(statement.bind(...values)),
      async all<T>() {
        await checkpoint('statement');
        const result = await statement.all<T>();
        if (observeStatements) await checkpoint('after-statement');
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
    prepare: (query) => wrap(db.prepare(query)),
    async batch<T>(statements: D1PreparedStatement[]) {
      await checkpoint('before-batch');
      if (observeBatchSize) await checkpoint(`batch-${statements.length}`);
      const result = await db.batch<T>(
        statements.map((statement) => originals.get(statement) ?? statement),
      );
      await checkpoint('after-batch');
      return result;
    },
    exec: db.exec.bind(db),
    dump: db.dump.bind(db),
    withSession: db.withSession.bind(db),
  };
}
export function vaultCheckpointWorker(
  worker: {
    fetch(request: Request, env: { DB: D1Database }): Promise<Response>;
  },
  observeRequests = false,
  options: {
    observeStatements?: boolean;
    observeBatchSize?: boolean;
    omitIp?: boolean;
  } = {},
) {
  return {
    async fetch(request: Request, env: { DB: D1Database }) {
      if (
        options.observeStatements &&
        new URL(request.url).pathname === '/api/__test/request-facts'
      )
        return Response.json({
          ip: request.headers.get('CF-Connecting-IP'),
          country:
            (request as Request & { cf?: { country?: string } }).cf?.country ??
            null,
        });
      if (observeRequests) {
        await checkpoint('request');
        const path = new URL(request.url).pathname;
        if (path === '/api/machine/secrets/values')
          await checkpoint('value-request');
        if (path === '/api/machine/secrets')
          await checkpoint('listing-request');
        if (path.endsWith('/reveal')) await checkpoint('reveal-request');
      }
      if (options.omitIp && new URL(request.url).pathname.endsWith('/reveal')) {
        // Miniflare supplies a loopback IP even if the HTTP header is omitted.
        // Remove that synthetic default to exercise an actually absent fact.
        const headers = new Headers(request.headers);
        headers.delete('CF-Connecting-IP');
        request = new Request(request, { headers });
      }
      return worker.fetch(request, {
        ...env,
        DB: decorate(
          env.DB,
          options.observeStatements ?? false,
          options.observeBatchSize ?? false,
        ),
      });
    },
  };
}
