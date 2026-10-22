import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import { Miniflare } from 'miniflare';
import {
  applyMigrations,
  migrationFiles,
  normalizedSchema,
} from './migrations.ts';

export const fileMigrations = [
  '0012_memory_files.sql',
  '0013_audit_file_entries.sql',
];
export async function seedPreviousAudit(db: D1Database) {
  const outcomes = ['created', 'delivered', 'denied', 'revealed'] as const;
  for (const outcome of outcomes) {
    const owner = outcome === 'revealed';
    const run = outcome === 'delivered' || outcome === 'denied';
    const machineFacts = owner
      ? [null, null, null]
      : ['synthetic-previous-machine', 'previous-LG16', '/synthetic/previous'];
    const commandFacts = run ? ['pnpm', randomUUID()] : [null, null];
    const networkFacts = owner ? ['203.0.113.67', 'AR'] : [null, null];
    await db
      .prepare(
        'INSERT INTO audit_entries(id,at,outcome,path,purpose,machine_id,machine_name,working_directory,executable,run_id,ip,country) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)',
      )
      .bind(
        randomUUID(),
        '2026-10-08T12:00:00.000Z',
        outcome,
        `work/mamasan/${outcome.toUpperCase()}_KEY`,
        `Historical ${outcome} purpose`,
        ...machineFacts,
        ...commandFacts,
        ...networkFacts,
      )
      .run();
  }
  return (
    await db
      .prepare('SELECT * FROM audit_entries ORDER BY id')
      .all<Record<string, unknown>>()
  ).results;
}
export async function previousAuditInsert(db: D1Database) {
  const id = randomUUID();
  await db
    .prepare(
      "INSERT INTO audit_entries(id,at,outcome,path,purpose,ip,country) VALUES (?,?,'revealed',?,'Revealed in web app',?,?)",
    )
    .bind(
      id,
      '2026-10-22T18:00:00.000Z',
      'work/mamasan/LEGACY_KEY',
      '203.0.113.67',
      'AR',
    )
    .run();
  const row = await db
    .prepare('SELECT * FROM audit_entries WHERE id=?')
    .bind(id)
    .first<Record<string, unknown>>();
  if (!row)
    throw new Error('The previous Worker audit insert did not persist.');
  return row;
}
async function checkHistoricalAudit(
  previous: D1Database,
  entries: Record<string, unknown>[],
) {
  for (const entry of entries) {
    const row = await previous
      .prepare('SELECT * FROM audit_entries WHERE id=?')
      .bind(entry.id)
      .first<Record<string, unknown>>();
    if (
      row?.bucket !== 'work/mamasan' ||
      Object.entries(entry).some(([key, value]) => row[key] !== value)
    )
      throw new Error(
        'The attachment audit rebuild lost a historical Vault fact.',
      );
  }
}
export async function verifyMemoryFilesMigrations(directory = 'migrations') {
  const names = await migrationFiles(directory);
  if (!fileMigrations.every((name) => names.includes(name)))
    throw new Error(
      'Memory file attachments require migrations 0012_memory_files.sql and 0013_audit_file_entries.sql.',
    );
  const mf = new Miniflare({
    modules: true,
    cf: false,
    script: 'export default {fetch(){return new Response()}}',
    d1Databases: ['Fresh', 'Previous'],
    d1Persist: false,
  });
  try {
    const fresh = await mf.getD1Database('Fresh');
    await applyMigrations(fresh, directory);
    const schema = await normalizedSchema(fresh);
    if (
      (await applyMigrations(fresh, directory)).length ||
      (await normalizedSchema(fresh)) !== schema
    )
      throw new Error(
        'Attachment replay changed an already-migrated database.',
      );
    const previous = await mf.getD1Database('Previous');
    await applyMigrations(previous, directory, {
      only: names.filter((name) => !fileMigrations.includes(name)),
    });
    const entries = await seedPreviousAudit(previous);
    await applyMigrations(previous, directory);
    await checkHistoricalAudit(previous, entries);
    const inserted = await previousAuditInsert(previous);
    if (inserted.bucket !== 'work/mamasan')
      throw new Error(
        'The previous Worker audit writer did not receive its bucket from the compatibility trigger.',
      );
    if ((await normalizedSchema(previous)) !== schema)
      throw new Error(
        'Attachment upgrade differs from the empty-database schema.',
      );
    return {
      filesReplayed: true,
      previousAuditRowsPreserved: entries.length,
      compatibilityTrigger: true,
    };
  } finally {
    await mf.dispose();
  }
}
