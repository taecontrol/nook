import { afterEach, expect, it } from 'vitest';
import worker from '../apps/worker/src/index.ts';
import { memoryClient } from './support/memory.ts';
import {
  attachFile,
  downloadFile,
  fileMemory,
  filePath,
  pdfName,
  seedFileMemory,
} from './support/memory-files.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';

let app: FilesRuntime;
afterEach(() => app?.close());

function expectStatements(
  statements: number,
  roundTrips: number,
  batches: number[],
) {
  const individual = app.labels.filter(
    (label) => label === '/statement',
  ).length;
  const actualBatches = app.labels.flatMap((label) => {
    const match = /^\/batch-(\d+)$/.exec(label);
    return match ? [Number(match[1])] : [];
  });
  expect({
    statements: individual + actualBatches.reduce((sum, size) => sum + size, 0),
    roundTrips: individual + actualBatches.length,
    batches: actualBatches,
  }).toEqual({ statements, roundTrips, batches });
  app.labels.length = 0;
}

it('file operations retain their D1 statement and round-trip budgets', async () => {
  app = await filesRuntime();
  const machine = await seedFileMemory(app);
  const owner = memoryClient(app, '2026-07-28');
  app.labels.length = 0;
  await attachFile(app, machine.token);
  expectStatements(7, 4, [4]);
  expect((await attachFile(app, machine.token)).outcome).toBe('unchanged');
  expectStatements(3, 3, []);
  const replacement = await attachFile(app, machine.token, {
    bytes: Buffer.from('replacement'),
  });
  expect(replacement.outcome).toBe('replaced');
  expectStatements(7, 4, [4]);
  const machineDownload = await downloadFile(app, machine.token);
  expect(machineDownload.status).toBe(200);
  await machineDownload.arrayBuffer();
  expectStatements(4, 4, []);
  const ownerDownload = await fetch(
    app.origin + filePath(fileMemory, pdfName, false),
  );
  expect(ownerDownload.status).toBe(200);
  await ownerDownload.arrayBuffer();
  expectStatements(3, 3, []);
  expect(
    (
      await owner.call('detach', {
        id: fileMemory,
        name: pdfName,
        sha256: replacement.sha256,
      })
    ).isError,
  ).not.toBe(true);
  expectStatements(4, 2, [3]);
  await attachFile(app, machine.token);
  app.labels.length = 0;
  expect(
    (await owner.call('forget', { id: fileMemory, expectedVersion: 1 }))
      .isError,
  ).not.toBe(true);
  expectStatements(7, 2, [6]);
});

it('Cron retains its persisted cursor when file storage is missing or fails without a cursor error', async () => {
  app = await filesRuntime();
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare("INSERT INTO file_sweep(id,cursor) VALUES(1,'resume-me')")
    .run();
  const controller = {
    scheduledTime: Date.now(),
    cron: '*/5 * * * *',
    noRetry() {},
  };
  const env = { ...app.bindings, DB: db };
  await worker.scheduled(controller, env);
  expect(
    await db.prepare('SELECT cursor FROM file_sweep WHERE id=1').first(),
  ).toEqual({ cursor: 'resume-me' });
  const bucket = await app.mf.getR2Bucket('FILES');
  const unavailable = new Proxy(bucket, {
    get(target, key) {
      if (key === 'list')
        return async () => {
          throw new Error('Synthetic storage outage');
        };
      return Reflect.get(target, key, target);
    },
  });
  await worker.scheduled(controller, {
    ...env,
    FILES: unavailable as unknown as Parameters<
      typeof worker.fetch
    >[1]['FILES'],
  });
  expect(
    await db.prepare('SELECT cursor FROM file_sweep WHERE id=1').first(),
  ).toEqual({ cursor: 'resume-me' });
});
