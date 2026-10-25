import { Miniflare } from 'miniflare';
import { expect, it } from 'vitest';
import { applyMigrations, migrationFiles } from '../scripts/lib/migrations.ts';
import { auditRows } from './support/audit.ts';
import {
  fileMemory,
  fileObjects,
  fileRows,
  seedFile,
  seedFileMemory,
} from './support/memory-files.ts';
import {
  previousAuditInsert,
  seedPreviousAudit,
} from './support/memory-files-audit.ts';
import { previousFilesWorker } from './support/memory-files-previous-worker.ts';

it('E27/E30: the audit rebuild preserves every Vault fact and backfills bucket; previous inserts receive it from the trigger', async () => {
  const mf = new Miniflare({
    modules: true,
    cf: false,
    script: 'export default {fetch(){return new Response()}}',
    d1Databases: ['DB'],
    d1Persist: false,
  });
  try {
    const db = await mf.getD1Database('DB');
    const names = await migrationFiles('migrations');
    // The schema the previous Worker ran: every migration before files.
    await applyMigrations(db, 'migrations', {
      only: names.filter((name) => name < '0012_memory_files.sql'),
    });
    const before = await seedPreviousAudit(db);
    await applyMigrations(db);
    const rows = (
      await db
        .prepare('SELECT * FROM audit_entries ORDER BY id')
        .all<Record<string, unknown>>()
    ).results;
    expect(rows).toHaveLength(before.length);
    for (const previous of before)
      expect(rows.find((row) => row.id === previous.id)).toMatchObject({
        ...previous,
        bucket: 'work/mamasan',
      });
    expect(await previousAuditInsert(db)).toMatchObject({
      bucket: 'work/mamasan',
      path: 'work/mamasan/LEGACY_KEY',
      outcome: 'revealed',
      purpose: 'Revealed in web app',
      ip: '203.0.113.67',
      country: 'AR',
    });
  } finally {
    await mf.dispose();
  }
});
it('E30: the actual previous Worker returns 503 when RESTRICT protects attached files from unaudited forget', async () => {
  const app = await previousFilesWorker();
  try {
    await seedFileMemory(app);
    await seedFile(app);
    const files = await fileRows(app);
    const audit = await auditRows(app);
    const response = await fetch(
      `${app.origin}/api/memories/${fileMemory}?expectedVersion=1`,
      { method: 'DELETE' },
    );
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ _tag: 'ServiceUnavailable' });
    expect(await fileRows(app)).toEqual(files);
    expect(await auditRows(app)).toEqual(audit);
    expect(await fileObjects(app)).toHaveLength(1);
    expect(
      await (await app.mf.getD1Database('DB'))
        .prepare('SELECT current_version FROM memories WHERE id=?')
        .bind(fileMemory)
        .first(),
    ).toEqual({ current_version: 1 });
    expect(
      (
        await (
          await app.mf.getD1Database('DB')
        )
          .prepare('SELECT * FROM memory_versions WHERE memory_id=?')
          .bind(fileMemory)
          .all()
      ).results,
    ).toHaveLength(1);
  } finally {
    await app.close();
  }
});
