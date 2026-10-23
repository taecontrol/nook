import { expect } from 'vitest';
import { seedPreviousAudit } from '../../scripts/lib/memory-files-migrations.ts';
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
