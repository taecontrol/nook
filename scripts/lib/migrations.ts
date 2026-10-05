import { execFileSync } from 'node:child_process';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import { unstable_splitSqlQuery } from 'wrangler';
import { testEnvironment } from './test-environment.ts';

const tracking =
  'CREATE TABLE IF NOT EXISTS d1_migrations (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT UNIQUE, applied_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP NOT NULL)';
export async function migrationFiles(directory: string) {
  return (await readdir(directory))
    .filter((name) => /^\d{4}_[a-z0-9_]+\.sql$/.test(name))
    .sort();
}
function forbidTransactions(sql: string, name: string) {
  const uncommented = sql
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/--[^\n]*/g, '');
  if (
    /\bBEGIN\s+(?:DEFERRED\s+|IMMEDIATE\s+|EXCLUSIVE\s+)?TRANSACTION\b/i.test(
      uncommented,
    )
  )
    throw new Error(
      `Migration ${name}: BEGIN TRANSACTION is unsupported by remote D1.`,
    );
}
export async function applyMigrations(
  db: D1Database,
  directory = 'migrations',
  options: { only?: string[] } = {},
) {
  await db.prepare(tracking).run();
  const applied = new Set(
    (
      await db
        .prepare('SELECT name FROM d1_migrations ORDER BY id')
        .all<{ name: string }>()
    ).results.map((row) => row.name),
  );
  const done = [];
  for (const name of await migrationFiles(directory)) {
    const sql = await readFile(join(directory, name), 'utf8');
    forbidTransactions(sql, name);
    if (applied.has(name) || (options.only && !options.only.includes(name)))
      continue;
    try {
      // Wrangler appends tracking before splitting; the file must separate it.
      const query = `${sql}\nINSERT INTO d1_migrations (name) VALUES ('${name}');`;
      await db.batch(
        unstable_splitSqlQuery(query).map((part) => db.prepare(part)),
      );
    } catch {
      throw new Error(`Migration ${name} failed to apply.`);
    }
    done.push(name);
  }
  return done;
}
const quotedSql = /('(?:''|[^'])*'|"(?:""|[^"])*"|`(?:``|[^`])*`|\[[^\]]*\])/g;
const sqlTokens = new RegExp(
  `${/--[^\n]*|\/\*[\s\S]*?\*\//.source}|${quotedSql.source}`,
  'g',
);
export function normalizeSchema(sql: string) {
  // Formatting may change outside quotes; literal and identifier bytes may not.
  return sql
    .replace(sqlTokens, (token) =>
      token.startsWith('--') || token.startsWith('/*') ? ' ' : token,
    )
    .split(quotedSql)
    .map((part, index) =>
      index % 2
        ? part
        : part.replace(/\s+/g, ' ').replace(/\( /g, '(').replace(/ \)/g, ')'),
    )
    .join('')
    .trim();
}
export async function normalizedSchema(db: D1Database) {
  const rows = await db
    .prepare(
      "SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type, name",
    )
    .all<{ sql: string }>();
  return `${rows.results.map((row) => `${normalizeSchema(row.sql).replace(/;$/, '')};`).join('\n')}\n`;
}
export async function checkMigrationHistory({
  cwd = process.cwd(),
  directory = 'migrations',
  baseRef = 'origin/main',
}: {
  cwd?: string;
  directory?: string;
  baseRef?: string;
} = {}) {
  try {
    execFileSync('git', ['rev-parse', '--verify', baseRef], {
      cwd,
      env: testEnvironment(process.env.HOME),
      stdio: 'ignore',
    });
  } catch {
    throw new Error(
      `Migration immutability requires ${baseRef}; fetch the base branch first.`,
    );
  }
  const names = execFileSync(
    'git',
    ['ls-tree', '-r', '--name-only', baseRef, '--', directory],
    { cwd, encoding: 'utf8', env: testEnvironment(process.env.HOME) },
  )
    .trim()
    .split('\n')
    .filter((path) => /\d{4}_[^/]+\.sql$/.test(path));
  for (const path of names) {
    const published = execFileSync('git', ['show', `${baseRef}:${path}`], {
      cwd,
      env: testEnvironment(process.env.HOME),
    });
    const current = await readFile(join(cwd, path)).catch(() => undefined);
    if (!current?.equals(published))
      throw new Error(
        `Published migration ${path} is immutable and cannot be edited or removed.`,
      );
  }
}
function database() {
  return new Miniflare({
    modules: true,
    script: 'export default {fetch(){return new Response()}}',
    d1Databases: ['DB'],
    d1Persist: false,
  });
}
async function verifyReplay(db: D1Database, directory: string) {
  const applied = await applyMigrations(db, directory);
  const schema = await normalizedSchema(db);
  if (
    (await applyMigrations(db, directory)).length !== 0 ||
    (await normalizedSchema(db)) !== schema
  )
    throw new Error('Already-migrated replay changed the database.');
  return { applied, schema };
}
async function verifyUpgrade(
  previous: D1Database,
  directory: string,
  names: string[],
  schema: string,
) {
  await applyMigrations(previous, directory, { only: names.slice(0, -1) });
  await previous
    .prepare('INSERT INTO buckets(path, created_at) VALUES (?, ?)')
    .bind('verification-kept', '2026-10-04T00:00:00.000Z')
    .run();
  await applyMigrations(previous, directory);
  const kept = await previous
    .prepare("SELECT created_at FROM buckets WHERE path='verification-kept'")
    .first<{ created_at: string }>();
  if (
    kept?.created_at !== '2026-10-04T00:00:00.000Z' ||
    (await normalizedSchema(previous)) !== schema
  )
    throw new Error(
      'Populated migration upgrade lost data or changed the schema.',
    );
}

export async function verifyMigrations({
  directory = 'migrations',
  baseRef = 'origin/main',
}: {
  directory?: string;
  baseRef?: string;
} = {}) {
  if (baseRef) await checkMigrationHistory({ directory, baseRef });
  const fresh = database();
  const populated = database();
  try {
    const db = await fresh.getD1Database('DB');
    const names = await migrationFiles(directory);
    if (!names.length) throw new Error('No migrations found.');
    const { applied, schema } = await verifyReplay(db, directory);
    await verifyUpgrade(
      await populated.getD1Database('DB'),
      directory,
      names,
      schema,
    );
    const snapshot = await readFile(join(directory, 'schema.sql'), 'utf8');
    if (normalizeSchema(snapshot) !== normalizeSchema(schema))
      throw new Error(
        'Schema snapshot drift: migrations do not match migrations/schema.sql.',
      );
    return {
      applied,
      replayed: true,
      unchanged: true,
      upgraded: true,
      schemaMatches: true,
    };
  } finally {
    await fresh.dispose();
    await populated.dispose();
  }
}
