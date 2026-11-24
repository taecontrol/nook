import type {
  D1Database,
  D1PreparedStatement,
} from '@cloudflare/workers-types';

const controlledTime = /unixepoch\('subsec'\)/g;
const uncontrolledTime = [
  /["']now["']/i,
  /\bcurrent_(?:date|time|timestamp)\b/i,
  /\b(?:date|time|datetime|julianday|unixepoch|timediff)\s*\(\s*(?:\)|["'])/i,
  /\bstrftime\s*\(\s*'[^']*'\s*(?:\)|,\s*["'])/i,
];

export function clockedQuery(query: string, now: number) {
  const clocked = query.replace(controlledTime, `(${now}/1000.0)`);
  if (uncontrolledTime.some((spelling) => spelling.test(clocked)))
    throw new Error(
      `This query reads SQLite time in a spelling the test clock does not control; read it as unixepoch('subsec'): ${query}`,
    );
  return clocked;
}

export function clockDatabase(
  db: D1Database,
  clock: () => Promise<number>,
  batchClockStepMs = 0,
): D1Database {
  const statements = new WeakMap<
    D1PreparedStatement,
    { query: string; values: unknown[] }
  >();
  function native(query: string, values: unknown[], now: number) {
    return db.prepare(clockedQuery(query, now)).bind(...values);
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
