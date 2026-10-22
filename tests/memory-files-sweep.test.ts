import { randomUUID } from 'node:crypto';
import { afterEach, expect, it } from 'vitest';
import {
  fileObjects,
  fileRows,
  seedFile,
  seedFileMemory,
} from './support/memory-files.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';

let app: FilesRuntime;
afterEach(() => app?.close());

it('Cron walks bounded pages, retains live references, and completes cleanup across invocations beyond D1 parameter limits', async () => {
  app = await filesRuntime();
  await seedFileMemory(app);
  const live = await seedFile(app);
  const before = await fileRows(app);
  const bucket = await app.mf.getR2Bucket('FILES');
  for (let start = 0; start < 1002; start += 40)
    await Promise.all(
      Array.from({ length: Math.min(40, 1002 - start) }, () =>
        bucket.put(`files/${randomUUID()}`, new Uint8Array()),
      ),
    );
  const all = await fileObjects(app);
  expect(all).toHaveLength(1003);
  app.setTime(
    Math.max(...all.map((object) => object.uploaded.getTime())) + 3_600_001,
  );
  expect((await app.sweep()).status).toBe(204);
  const remaining = await fileObjects(app);
  expect(remaining.length).toBeGreaterThanOrEqual(3);
  expect(remaining.length).toBeLessThanOrEqual(4);
  const db = await app.mf.getD1Database('DB');
  expect(
    await db.prepare('SELECT cursor FROM file_sweep WHERE id=1').first(),
  ).toEqual({ cursor: expect.any(String) });
  expect((await app.sweep()).status).toBe(204);
  expect((await fileObjects(app)).map((object) => object.key)).toEqual([
    live.object_key,
  ]);
  expect(await fileRows(app)).toEqual(before);
  expect(
    await db.prepare('SELECT cursor FROM file_sweep WHERE id=1').first(),
  ).toEqual({ cursor: null });
});

it('a rejected persisted R2 cursor resets the walk and the next Cron can collect old garbage', async () => {
  app = await filesRuntime({
    checkpoint: async (label) => label !== '/r2/list-cursor',
  });
  await seedFileMemory(app);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('INSERT INTO file_sweep(id,cursor) VALUES(1,?)')
    .bind('synthetic-rejected-cursor')
    .run();
  const bucket = await app.mf.getR2Bucket('FILES');
  await bucket.put(`files/${randomUUID()}`, new Uint8Array());
  app.setTime((await fileObjects(app))[0].uploaded.getTime() + 3_600_001);
  expect((await app.sweep()).status).toBe(204);
  expect(app.labels).toContain('/r2/list-cursor');
  expect(
    await db.prepare('SELECT cursor FROM file_sweep WHERE id=1').first(),
  ).toEqual({ cursor: null });
  expect(await fileObjects(app)).toHaveLength(1);
  expect((await app.sweep()).status).toBe(204);
  expect(await fileObjects(app)).toEqual([]);
});
