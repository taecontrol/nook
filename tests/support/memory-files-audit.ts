import { randomUUID } from 'node:crypto';
import type { D1Database } from '@cloudflare/workers-types';
import { expect } from 'vitest';
import { auditRows } from './audit.ts';
import { memoryClient, memoryFixture, seedMemories } from './memory.ts';
import {
  attachFile,
  downloadFile,
  fileBucket,
  fileMemory,
  pdfName,
  seedFileMemory,
} from './memory-files.ts';
import type { TestRuntime } from './runtime.ts';

export async function fileAuditLifecycle(app: TestRuntime) {
  const machine = await seedFileMemory(app);
  await seedPreviousAudit(await app.mf.getD1Database('DB'));
  const before = await auditRows(app);
  await attachFile(app, machine.token);
  const replacement = await attachFile(app, machine.token, {
    bytes: Buffer.from('replacement audit fixture'),
  });
  const downloaded = await downloadFile(app, machine.token);
  expect(downloaded.status).toBe(200);
  await downloaded.arrayBuffer();
  const detached = await memoryClient(app, '2026-07-28').call('detach', {
    id: fileMemory,
    name: pdfName,
    sha256: replacement.sha256,
  });
  expect(detached.isError).not.toBe(true);
  await attachFile(app, machine.token, { name: 'forgotten.pdf' });
  expect(
    (
      await fetch(
        `${app.origin}/api/memories/${fileMemory}?expectedVersion=1`,
        { method: 'DELETE' },
      )
    ).status,
  ).toBe(204);
  return { before, machine };
}
export async function moreFileAudit(app: TestRuntime, token: string) {
  await seedMemories(app, [
    memoryFixture(607, { bucket: fileBucket, content: 'More audit files.' }),
  ]);
  for (let i = 0; i < 26; i++)
    await attachFile(app, token, {
      id: memoryFixture(607).id,
      name: `page-${i}.pdf`,
    });
}
export async function fileAuditPage(app: TestRuntime, query = '') {
  const response = await fetch(`${app.origin}/api/audit${query}`);
  expect(
    response.status,
    'The owner Audit API decodes both Vault and file rows',
  ).toBe(200);
  return (await response.json()) as {
    entries: Record<string, unknown>[];
    next: string | null;
  };
}
// Vault audit rows and writes as they existed before file attachments.
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
