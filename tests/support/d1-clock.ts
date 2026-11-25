import type {
  D1Database,
  D1PreparedStatement,
} from '@cloudflare/workers-types';

type Token = {
  kind: 'clock' | 'name' | 'quoted' | 'string' | 'other';
  text: string;
  start: number;
  end: number;
};

const lexeme =
  /\s+|--[^\n]*|\/\*[\s\S]*?(?:\*\/|$)|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]|\?\d*|[:@$]\w+|\.?\d[\w.]*|[a-z_\u0080-￿][\w$\u0080-￿]*|[\s\S]/giy;
const timeFunctions: Record<string, number[]> = {
  date: [0],
  time: [0],
  datetime: [0],
  julianday: [0],
  unixepoch: [0],
  strftime: [1],
  timediff: [0, 1],
};
const nowAliases = ['now', 'subsec', 'subsecond'];

function isMark(next: Token | undefined, text: string) {
  return next?.kind === 'other' && next.text === text;
}

function token(text: string, start: number): Token | undefined {
  if (/^(?:\s|--|\/\*)/.test(text)) return undefined;
  const end = start + text.length;
  const inner = text.slice(1, -1).toLowerCase();
  if (text[0] === "'") return { kind: 'string', text: inner, start, end };
  if ('"`['.includes(text[0]))
    return { kind: 'quoted', text: inner, start, end };
  if (/^[a-z_\u0080-￿]/i.test(text))
    return { kind: 'name', text: text.toLowerCase(), start, end };
  return { kind: 'other', text, start, end };
}

function tokenize(query: string) {
  const tokens: Token[] = [];
  lexeme.lastIndex = 0;
  for (let match = lexeme.exec(query); match; match = lexeme.exec(query)) {
    const next = token(match[0], match.index);
    if (next) tokens.push(next);
  }
  return tokens;
}

function isClock(tokens: Token[], at: number) {
  const [name, open, mode, close] = tokens.slice(at, at + 4);
  return (
    name?.kind === 'name' &&
    name.text === 'unixepoch' &&
    isMark(open, '(') &&
    mode?.kind === 'string' &&
    mode.text === 'subsec' &&
    isMark(close, ')')
  );
}

function withClocks(tokens: Token[]) {
  const result: Token[] = [];
  for (let at = 0; at < tokens.length; at++) {
    if (isClock(tokens, at)) {
      result.push({ ...tokens[at], kind: 'clock', end: tokens[at + 3].end });
      at += 3;
    } else result.push(tokens[at]);
  }
  return result;
}

function callArguments(tokens: Token[], open: number) {
  const args: Token[][] = [[]];
  let depth = 0;
  for (const next of tokens.slice(open + 1)) {
    if (isMark(next, '(')) depth++;
    if (isMark(next, ')') && depth-- === 0) return args;
    if (isMark(next, ',') && depth === 0) args.push([]);
    else args[args.length - 1].push(next);
  }
  return undefined;
}

function isColumn(tokens: Token[]) {
  return (
    tokens.length % 2 === 1 &&
    tokens.every((next, at) =>
      at % 2 === 1
        ? isMark(next, '.')
        : next.kind === 'name' ||
          (next.kind === 'quoted' && !nowAliases.includes(next.text)),
    )
  );
}

function isFixedTime(time: Token[] | undefined) {
  return (
    time !== undefined &&
    ((time.length === 1 && time[0].kind === 'clock') || isColumn(time))
  );
}

function readsUncontrolledTime(tokens: Token[], at: number) {
  const current = tokens[at];
  if (
    (current.kind === 'name' || current.kind === 'quoted') &&
    /^current_(?:date|time|timestamp)$/.test(current.text)
  )
    return true;
  if (
    (current.kind === 'string' || current.kind === 'quoted') &&
    current.text === 'now'
  )
    return true;
  const timeValues =
    current.kind === 'name' || current.kind === 'quoted'
      ? timeFunctions[current.text]
      : undefined;
  if (!timeValues || !isMark(tokens[at + 1], '(')) return false;
  const args = callArguments(tokens, at + 1);
  return !args || !timeValues.every((index) => isFixedTime(args[index]));
}

export function clockedQuery(query: string, now: number) {
  const tokens = withClocks(tokenize(query));
  if (tokens.some((_, at) => readsUncontrolledTime(tokens, at)))
    throw new Error(
      `This query reads SQLite time in a form the test clock does not control; read the current time as unixepoch('subsec') or apply time functions to columns: ${query}`,
    );
  return tokens
    .filter((next) => next.kind === 'clock')
    .reduceRight(
      (clocked, clock) =>
        `${clocked.slice(0, clock.start)}(${now}/1000.0)${clocked.slice(clock.end)}`,
      query,
    );
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
