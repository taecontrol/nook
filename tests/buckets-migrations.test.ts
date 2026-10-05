import { execFile, execFileSync } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { unstable_splitSqlQuery } from 'wrangler';
import {
  applyMigrations,
  checkMigrationHistory,
  migrationFiles,
  normalizeSchema,
  verifyMigrations,
} from '../scripts/lib/migrations.ts';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

const execute = promisify(execFile);

async function fixture() {
  await mkdir('.local', { recursive: true });
  const directory = await mkdtemp(resolve('.local', 'migration-fixture-'));
  await cp('migrations', resolve(directory, 'migrations'), { recursive: true });
  return directory;
}
it('E22: migrations replay empty, already-migrated, and populated previous schema without drift or data loss', async () => {
  const report = await verifyMigrations();
  expect(report).toMatchObject({
    replayed: true,
    unchanged: true,
    upgraded: true,
    schemaMatches: true,
  });
});
it('E22/E23: Wrangler applies only the numbered migrations and preserves the local replay', async () => {
  const root = await fixture();
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  const configPath = resolve(root, 'wrangler.jsonc');
  const wrangler = (...args: string[]) =>
    execute(
      'pnpm',
      [
        'exec',
        'wrangler',
        'd1',
        ...args,
        '--config',
        configPath,
        '--local',
        '--persist-to',
        resolve(root, 'd1'),
      ],
      {
        env: testEnvironment(resolve(root, 'home'), {
          CI: '1',
          WRANGLER_SEND_METRICS: 'false',
        }),
        timeout: 15_000,
      },
    );
  const query =
    "SELECT name FROM d1_migrations ORDER BY id; SELECT path, created_at FROM buckets; SELECT sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite\\_%' ESCAPE '\\' AND name NOT LIKE '\\_cf\\_%' ESCAPE '\\' AND tbl_name <> 'd1_migrations' AND sql IS NOT NULL ORDER BY type, name;";
  try {
    await writeFile(
      configPath,
      JSON.stringify({ name: 'nook', d1_databases: config.d1_databases }),
    );
    await wrangler('migrations', 'apply', 'DB');
    const first = JSON.parse(
      (await wrangler('execute', 'DB', '--command', query, '--json')).stdout,
    );
    expect(first[0].results).toEqual([
      { name: '0001_buckets.sql' },
      { name: '0002_reserve_me.sql' },
      { name: '0003_machine_authorizations.sql' },
      { name: '0004_machine_management.sql' },
    ]);
    expect(first[1].results).toEqual([
      { path: 'me', created_at: expect.any(String) },
    ]);
    expect(
      normalizeSchema(
        first[2].results
          .map((row: { sql: string }) => `${row.sql.replace(/;$/, '')};`)
          .join('\n'),
      ),
    ).toBe(normalizeSchema(await readFile('migrations/schema.sql', 'utf8')));
    await wrangler('migrations', 'apply', 'DB');
    expect(
      JSON.parse(
        (await wrangler('execute', 'DB', '--command', query, '--json')).stdout,
      ),
    ).toMatchObject(
      first.map((result: { results: unknown[] }) => ({
        results: result.results,
      })),
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
it.each([
  ['broken SQL', '0002_broken.sql', 'CREATE TABL broken(x);', /0002_broken/],
  [
    'BEGIN TRANSACTION',
    '0002_transaction.sql',
    'BEGIN TRANSACTION; CREATE TABLE extra(x); COMMIT;',
    /BEGIN TRANSACTION/,
  ],
  [
    'schema drift',
    'schema.sql',
    'CREATE TABLE unrelated(x);',
    /schema.*(drift|match)|snapshot/i,
  ],
])(
  'E25: migration verification rejects %s for the intended reason',
  async (_name, file, sql, message) => {
    const root = await fixture();
    try {
      await writeFile(resolve(root, 'migrations', String(file)), String(sql));
      await expect(
        verifyMigrations({
          directory: resolve(root, 'migrations'),
          baseRef: undefined,
        }),
      ).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.each(['edited', 'removed', 'missing base'])(
  'E25: migration history fails closed when a published migration is %s',
  async (change) => {
    const root = await fixture();
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', root, ...args], {
        encoding: 'utf8',
        env: testEnvironment(resolve(root, 'home'), {
          GIT_CONFIG_NOSYSTEM: '1',
        }),
      });
    try {
      git('init');
      git('add', 'migrations');
      git(
        '-c',
        'user.name=Synthetic Owner',
        '-c',
        'user.email=owner@nook.test',
        'commit',
        '-m',
        'Published migration fixture',
      );
      git('update-ref', 'refs/remotes/origin/main', 'HEAD');
      if (change === 'edited')
        await writeFile(
          resolve(root, 'migrations/0001_buckets.sql'),
          `${await readFile('migrations/0001_buckets.sql', 'utf8')}\n-- altered\n`,
        );
      if (change === 'removed')
        await rm(resolve(root, 'migrations/0001_buckets.sql'));
      await expect(
        checkMigrationHistory({
          cwd: root,
          baseRef:
            change === 'missing base' ? 'origin/unavailable' : 'origin/main',
        }),
      ).rejects.toThrow(
        change === 'missing base'
          ? /fetch the base branch/i
          : /published|immutable|edited/i,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
it.each([
  ['SQL failure', 'CREATE TABLE partial(x); INSERT INTO missing VALUES(1);'],
  ['missing final semicolon', 'CREATE TABLE partial(x)'],
])(
  'E22: a file with %s is atomic and never enters d1_migrations',
  async (_kind, sql) => {
    const root = await fixture();
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response()}}',
      d1Databases: ['DB'],
    });
    try {
      await writeFile(resolve(root, 'migrations/0002_broken.sql'), sql);
      const db = await mf.getD1Database('DB');
      await expect(
        applyMigrations(db, resolve(root, 'migrations')),
      ).rejects.toThrow(/0002_broken/);
      expect(
        await db
          .prepare("SELECT name FROM sqlite_schema WHERE name='partial'")
          .all(),
      ).toMatchObject({ results: [] });
      expect(
        await db.prepare('SELECT name FROM d1_migrations').all(),
      ).toMatchObject({ results: [{ name: '0001_buckets.sql' }] });
    } finally {
      await mf.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it('E22/E25: schema drift inside a SQL literal is rejected, while syntax formatting is accepted', async () => {
  const root = await fixture();
  const snapshot = await readFile('migrations/schema.sql', 'utf8');
  try {
    await writeFile(
      resolve(root, 'migrations/schema.sql'),
      snapshot.replace('cannot be', 'cannot  be'),
    );
    await expect(
      verifyMigrations({ directory: resolve(root, 'migrations'), baseRef: '' }),
    ).rejects.toThrow(/snapshot drift/i);
    await writeFile(
      resolve(root, 'migrations/schema.sql'),
      snapshot.replace(/CREATE /g, 'CREATE\n  '),
    );
    expect(
      await verifyMigrations({
        directory: resolve(root, 'migrations'),
        baseRef: '',
      }),
    ).toMatchObject({ schemaMatches: true });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

it.each([
  ["-- Owner's reserved bucket rule", 'SELECT RAISE'],
  ['/* Owner\'s "reserved" [bucket] `rule` */', 'SELECT RAISE'],
  ['/* token separator */', 'CREATE TRIGGER'],
])(
  'E22/E25: SQL comment %s preserves matching schemas and different trigger messages',
  async (comment, target) => {
    const root = await fixture();
    const directory = resolve(root, 'migrations');
    const mf = new Miniflare({
      modules: true,
      script: 'export default {fetch(){return new Response()}}',
      d1Databases: ['Migrated', 'Snapshot'],
    });
    const commented = (sql: string) =>
      sql.replace(
        target,
        target === 'CREATE TRIGGER'
          ? `CREATE${comment}TRIGGER`
          : `${comment}\n  ${target}`,
      );
    try {
      await writeFile(
        resolve(directory, '0002_reserve_me.sql'),
        commented(await readFile('migrations/0002_reserve_me.sql', 'utf8')),
      );
      const snapshot = commented(
        await readFile('migrations/schema.sql', 'utf8'),
      );
      await writeFile(resolve(directory, 'schema.sql'), snapshot);
      expect(await verifyMigrations({ directory, baseRef: '' })).toMatchObject({
        schemaMatches: true,
      });
      const migrated = await mf.getD1Database('Migrated');
      await applyMigrations(migrated, directory);
      await expect(
        migrated.prepare("DELETE FROM buckets WHERE path='me'").run(),
      ).rejects.toThrow('The me bucket cannot be deleted.');

      const drifting = snapshot.replace('cannot be', 'cannot  be');
      const independent = await mf.getD1Database('Snapshot');
      // The normalized snapshot sorts by type, so tables must precede indexes
      // when independently replaying it rather than comparing its schema.
      const statements = unstable_splitSqlQuery(drifting).toSorted(
        (left, right) =>
          Number(/^CREATE TABLE\b/i.test(right)) -
          Number(/^CREATE TABLE\b/i.test(left)),
      );
      await independent.batch([
        ...statements.map((sql) => independent.prepare(sql)),
        independent
          .prepare('INSERT INTO buckets VALUES (?, ?)')
          .bind('me', '2026-10-04T00:00:00.000Z'),
      ]);
      await expect(
        independent.prepare("DELETE FROM buckets WHERE path='me'").run(),
      ).rejects.toThrow('The me bucket cannot  be deleted.');
      await writeFile(resolve(directory, 'schema.sql'), drifting);
      await expect(
        verifyMigrations({ directory, baseRef: '' }),
      ).rejects.toThrow(/snapshot drift/i);
    } finally {
      await mf.dispose();
      await rm(root, { recursive: true, force: true });
    }
  },
);

it.each([
  [
    'double quoted identifier',
    '"quoted  table"',
    "'value'",
    'quoted  table',
    'quoted table',
  ],
  [
    'backtick identifier',
    '`quoted  table`',
    "'value'",
    'quoted  table',
    'quoted table',
  ],
  [
    'bracket identifier',
    '[quoted  table]',
    "'value'",
    'quoted  table',
    'quoted table',
  ],
  [
    'literal punctuation',
    'quoted_table',
    "'value ( kept )'",
    '( kept )',
    '(kept)',
  ],
  [
    'escaped literal',
    'quoted_table',
    "'owner''s  ( value )'",
    '( value )',
    '(value)',
  ],
  [
    'line comment inside literal',
    'quoted_table',
    "'value -- kept'",
    '-- kept',
    '-- drift',
  ],
  [
    'block comment inside literal',
    'quoted_table',
    "'value /* kept */'",
    '/* kept */',
    '/* drift */',
  ],
])(
  'E22/E25: schema drift preserves %s bytes',
  async (_kind, table, value, original, changed) => {
    const root = await fixture();
    const directory = resolve(root, 'migrations');
    const statement = `CREATE TABLE ${table} (x TEXT DEFAULT ${value});`;
    const snapshot = (await readFile('migrations/schema.sql', 'utf8')).replace(
      'CREATE TRIGGER',
      `${statement}\nCREATE TRIGGER`,
    );
    try {
      await writeFile(resolve(directory, '0003_quoted.sql'), statement);
      await writeFile(resolve(directory, 'schema.sql'), snapshot);
      expect(await verifyMigrations({ directory, baseRef: '' })).toMatchObject({
        schemaMatches: true,
      });
      await writeFile(
        resolve(directory, 'schema.sql'),
        snapshot.replace(original, changed),
      );
      await expect(
        verifyMigrations({ directory, baseRef: '' }),
      ).rejects.toThrow(/snapshot drift/i);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

const firstMigration =
  "CREATE TABLE IF NOT EXISTS buckets (path TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);\nINSERT OR IGNORE INTO buckets VALUES ('me','2026-10-04T00:00:00.000Z');\n";
const bucketSchema =
  'CREATE TABLE buckets (path TEXT PRIMARY KEY NOT NULL, created_at TEXT NOT NULL);\n';
const prematureTracking =
  "CREATE TRIGGER prematures AFTER INSERT ON buckets WHEN NEW.path <> 'me' BEGIN INSERT OR IGNORE INTO d1_migrations(name) VALUES ('0002_latest.sql'); END;\n";
it.each([
  [
    'replay changes tracking',
    firstMigration,
    "DELETE FROM d1_migrations WHERE name='0001_buckets.sql';",
    bucketSchema,
    /Already-migrated replay changed/,
  ],
  [
    'upgrade loses existing data',
    firstMigration,
    "DELETE FROM buckets WHERE path <> 'me';",
    bucketSchema,
    /Populated migration upgrade lost data/,
  ],
  [
    'upgrade skips schema changes',
    firstMigration + prematureTracking,
    'CREATE TABLE latest (x TEXT);',
    `${bucketSchema}CREATE TABLE latest (x TEXT);\n${prematureTracking}`,
    /Populated migration upgrade lost data/,
  ],
])(
  'E22: verification rejects a migration whose %s',
  async (_kind, first, latest, schema, message) => {
    const root = await fixture();
    const directory = resolve(root, 'migrations');
    try {
      for (const name of await migrationFiles(directory))
        if (name !== '0001_buckets.sql') await rm(resolve(directory, name));
      await writeFile(resolve(directory, '0001_buckets.sql'), String(first));
      await writeFile(resolve(directory, '0002_latest.sql'), String(latest));
      await writeFile(resolve(directory, 'schema.sql'), String(schema));
      await expect(
        verifyMigrations({ directory, baseRef: '' }),
      ).rejects.toThrow(message);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);
