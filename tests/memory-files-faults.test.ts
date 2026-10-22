import { afterEach, expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { deferred } from './support/machines.ts';
import { memoryClient } from './support/memory.ts';
import {
  attachFile,
  digest,
  downloadFile,
  expectHttpError,
  fileBucket,
  fileMemory,
  fileObjects,
  fileRows,
  fileSnapshot,
  maximumBucket,
  putFile,
  seedFileMemory,
  seedUsage,
} from './support/memory-files.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';

let app: FilesRuntime;
afterEach(() => app?.close());
async function reached(
  gate: ReturnType<typeof deferred>,
  operation: Promise<Response>,
) {
  await Promise.race([
    gate.promise,
    operation.then((response) => {
      expect(
        response.status,
        'Attach must reach real R2 before its publication can be gated',
      ).toBe(200);
      throw new Error(
        'The attach completed without reaching the R2 checkpoint.',
      );
    }),
  ]);
}
async function noDanglingRows() {
  const result = await (await app.mf.getD1Database('DB'))
    .prepare(
      'SELECT f.memory_id FROM memory_files f LEFT JOIN memories m ON m.id=f.memory_id WHERE m.id IS NULL',
    )
    .all();
  expect(result.results).toEqual([]);
}
const forget = () =>
  memoryClient(app, '2026-07-28').call('forget', {
    id: fileMemory,
    expectedVersion: 1,
  });

it.each([0, 1])(
  'E7: different bytes publish truthfully in controlled commit order %s and retain only the final object',
  async (firstCommit) => {
    const arrived = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let uploads = 0;
    app = await filesRuntime({
      checkpoint: async (label) => {
        if (label === '/r2/after-put') {
          const index = uploads++;
          arrived[index].resolve();
          await release[index].promise;
        }
        return true;
      },
    });
    const machine = await seedFileMemory(app);
    const bytes = [
      Buffer.from('first upload bytes'),
      Buffer.from('second upload bytes'),
    ];
    const operations: Promise<Response>[] = [];
    try {
      operations.push(putFile(app, machine.token, { bytes: bytes[0] }));
      await reached(arrived[0], operations[0]);
      operations.push(putFile(app, machine.token, { bytes: bytes[1] }));
      await reached(arrived[1], operations[1]);
      release[firstCommit].resolve();
      const first = await operations[firstCommit];
      expect(first.status).toBe(200);
      const created = await first.json();
      expect(created).toMatchObject({
        outcome: 'created',
        sha256: digest(bytes[firstCommit]),
        replacedSha256: null,
      });
      release[1 - firstCommit].resolve();
      const second = await operations[1 - firstCommit];
      expect(second.status).toBe(200);
      expect(await second.json()).toMatchObject({
        outcome: 'replaced',
        sha256: digest(bytes[1 - firstCommit]),
        replacedSha256: created.sha256,
      });
      expect((await fileRows(app)).map((row) => row.sha256)).toEqual([
        digest(bytes[1 - firstCommit]),
      ]);
      expect(await fileObjects(app)).toHaveLength(1);
      const response = await downloadFile(app, machine.token);
      expect(digest(new Uint8Array(await response.arrayBuffer()))).toBe(
        digest(bytes[1 - firstCommit]),
      );
      expect(
        (await auditRows(app))
          .filter((row) => row.outcome !== 'file_downloaded')
          .map((row) => row.outcome)
          .sort(),
      ).toEqual(['file_attached', 'file_replaced']);
      await noDanglingRows();
    } finally {
      for (const gate of release) gate.resolve();
      await Promise.allSettled(operations);
    }
  },
);
it('E7: concurrent identical bytes yield one created, one unchanged, one object and one original provenance', async () => {
  const arrived = [deferred(), deferred()];
  const release = [deferred(), deferred()];
  let uploads = 0;
  app = await filesRuntime({
    checkpoint: async (label) => {
      if (label === '/r2/after-put') {
        const index = uploads++;
        arrived[index].resolve();
        await release[index].promise;
      }
      return true;
    },
  });
  const machine = await seedFileMemory(app);
  const operations: Promise<Response>[] = [];
  try {
    operations.push(putFile(app, machine.token));
    await reached(arrived[0], operations[0]);
    operations.push(
      putFile(app, machine.token, {
        headers: { 'User-Agent': 'retry-client/2.0' },
      }),
    );
    await reached(arrived[1], operations[1]);
    release[0].resolve();
    expect((await operations[0]).status).toBe(200);
    expect(await (await operations[0]).json()).toMatchObject({
      outcome: 'created',
    });
    const original = await fileRows(app);
    release[1].resolve();
    expect((await operations[1]).status).toBe(200);
    expect(await (await operations[1]).json()).toMatchObject({
      outcome: 'unchanged',
      replacedSha256: null,
    });
    expect(await fileRows(app)).toEqual(original);
    expect(await fileObjects(app)).toHaveLength(1);
    expect(await auditRows(app)).toHaveLength(1);
  } finally {
    for (const gate of release) gate.resolve();
    await Promise.allSettled(operations);
  }
});
it.each([0, 1])(
  'E8: concurrent names share one live quota guard, commit order %s, and the loser leaves no object or audit',
  async (firstCommit) => {
    const arrived = [deferred(), deferred()];
    const release = [deferred(), deferred()];
    let uploads = 0;
    app = await filesRuntime({
      checkpoint: async (label) => {
        if (label === '/r2/after-put') {
          const index = uploads++;
          arrived[index].resolve();
          await release[index].promise;
        }
        return true;
      },
    });
    const machine = await seedFileMemory(app);
    await seedUsage(app, maximumBucket - 150);
    const names = ['first.bin', 'second.bin'];
    const operations: Promise<Response>[] = [];
    try {
      for (const index of [0, 1]) {
        operations.push(
          putFile(app, machine.token, {
            name: names[index],
            bytes: Buffer.alloc(100, index),
          }),
        );
        await reached(arrived[index], operations[index]);
      }
      release[firstCommit].resolve();
      expect((await operations[firstCommit]).status).toBe(200);
      release[1 - firstCommit].resolve();
      await expectHttpError(
        await operations[1 - firstCommit],
        409,
        'FileQuotaExceeded',
        `${fileBucket} files use 1,073,741,774 of 1,073,741,824 bytes; ${names[1 - firstCommit]} needs 100.`,
      );
      expect(
        (await fileRows(app))
          .filter((row) => names.includes(row.name))
          .map((row) => row.name),
      ).toEqual([names[firstCommit]]);
      expect(await fileObjects(app)).toHaveLength(1);
      expect((await auditRows(app)).map((row) => row.file_name)).toEqual([
        names[firstCommit],
      ]);
    } finally {
      for (const gate of release) gate.resolve();
      await Promise.allSettled(operations);
    }
  },
);
it.each(['forget-first', 'attach-first'] as const)(
  'E9: concurrent attach and forget in %s order never leave a dangling row or R2 object',
  async (order) => {
    const uploaded = deferred();
    const publish = deferred();
    const forgetArrived = deferred();
    const forgetCommit = deferred();
    let holdForget = false;
    let heldForget = false;
    app = await filesRuntime({
      checkpoint: async (label) => {
        if (label === '/r2/after-put') {
          uploaded.resolve();
          await publish.promise;
        }
        if (holdForget && !heldForget && label === '/before-batch') {
          heldForget = true;
          forgetArrived.resolve();
          await forgetCommit.promise;
        }
        return true;
      },
    });
    const machine = await seedFileMemory(app);
    const pending = putFile(app, machine.token);
    let forgotten: ReturnType<typeof forget> | undefined;
    try {
      await reached(uploaded, pending);
      if (order === 'forget-first') {
        expect((await forget()).isError).not.toBe(true);
        publish.resolve();
        await expectHttpError(
          await pending,
          404,
          'MemoryNotFound',
          'Memory not found.',
        );
        expect(await auditRows(app)).toEqual([]);
      } else {
        holdForget = true;
        forgotten = forget();
        await forgetArrived.promise;
        publish.resolve();
        expect((await pending).status).toBe(200);
        forgetCommit.resolve();
        expect((await forgotten).isError).not.toBe(true);
        expect((await auditRows(app)).map((row) => row.outcome).sort()).toEqual(
          ['file_attached', 'file_forgotten'],
        );
      }
      expect(await fileRows(app)).toEqual([]);
      expect(await fileObjects(app)).toEqual([]);
      await noDanglingRows();
    } finally {
      publish.resolve();
      forgetCommit.resolve();
      await Promise.allSettled([pending, forgotten]);
    }
  },
);
it('E10: interruption after put leaves no row; Cron keeps the orphan before 60 minutes and sweeps it after the grace', async () => {
  let stop = true;
  app = await filesRuntime({
    checkpoint: async (label) => !(label === '/r2/after-put' && stop),
  });
  const machine = await seedFileMemory(app);
  await expectHttpError(
    await putFile(app, machine.token),
    503,
    'ServiceUnavailable',
  );
  expect(await fileRows(app)).toEqual([]);
  const objects = await fileObjects(app);
  expect(objects).toHaveLength(1);
  expect(await auditRows(app)).toEqual([]);
  stop = false;
  const uploadedAt = objects[0].uploaded.getTime();
  app.setTime(uploadedAt + 3_600_000 - 1);
  expect((await app.sweep()).status).toBe(204);
  expect(await fileObjects(app)).toHaveLength(1);
  app.setTime(uploadedAt + 3_600_000 + 1);
  expect((await app.sweep()).status).toBe(204);
  expect(await fileObjects(app)).toEqual([]);
});
it('E10: an error after the publish commit returns 503, retains its live object and retries unchanged', async () => {
  let put = false;
  let ambiguous = true;
  app = await filesRuntime({
    checkpoint: async (label) => {
      if (label === '/r2/after-put') put = true;
      if (put && ambiguous && label === '/after-batch') {
        ambiguous = false;
        return false;
      }
      return true;
    },
  });
  const machine = await seedFileMemory(app);
  await expectHttpError(
    await putFile(app, machine.token),
    503,
    'ServiceUnavailable',
  );
  expect(
    put,
    'The injected failure follows a real R2 put and a committed D1 batch',
  ).toBe(true);
  expect(await fileRows(app)).toHaveLength(1);
  expect(await fileObjects(app)).toHaveLength(1);
  const before = await fileSnapshot(app);
  expect(await attachFile(app, machine.token)).toMatchObject({
    outcome: 'unchanged',
    replacedSha256: null,
  });
  expect(await fileSnapshot(app)).toEqual(before);
  app.setTime((await fileObjects(app))[0].uploaded.getTime() + 3_600_001);
  await app.sweep();
  expect(await fileSnapshot(app)).toEqual(before);
});
it.each([599_999, 600_000, 600_001])(
  'E10: publication at %s ms obeys the strict ten-minute window using the injected clock',
  async (elapsed) => {
    const start = Date.now();
    app = await filesRuntime({
      now: start,
      checkpoint: async (label) => {
        if (label === '/r2/after-put') app.setTime(start + elapsed);
        return true;
      },
    });
    const machine = await seedFileMemory(app);
    const response = await putFile(app, machine.token);
    if (elapsed < 600_000) {
      expect(response.status).toBe(200);
      expect(await fileRows(app)).toHaveLength(1);
      expect(await fileObjects(app)).toHaveLength(1);
    } else {
      await expectHttpError(response, 503, 'ServiceUnavailable');
      expect(await fileRows(app)).toEqual([]);
      expect(await fileObjects(app)).toEqual([]);
      expect(await auditRows(app)).toEqual([]);
    }
  },
);
it('E22: failed inline forget deletion makes downloads unavailable immediately and Cron later deletes all orphan keys', async () => {
  let refuseDelete = false;
  app = await filesRuntime({
    checkpoint: async (label) =>
      !(refuseDelete && label === '/r2/before-delete'),
  });
  const machine = await seedFileMemory(app);
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
    await attachFile(app, machine.token, { name });
  refuseDelete = true;
  app.labels.length = 0;
  expect((await forget()).isError).not.toBe(true);
  expect(app.labels.filter((label) => label === '/after-batch')).toHaveLength(
    1,
  );
  expect(await fileRows(app)).toEqual([]);
  const orphans = await fileObjects(app);
  expect(orphans).toHaveLength(3);
  for (const name of ['a.pdf', 'b.pdf', 'c.pdf'])
    await expectHttpError(
      await downloadFile(app, machine.token, fileMemory, name),
      404,
      'MemoryNotFound',
      'Memory not found.',
    );
  expect(
    (await auditRows(app)).filter((row) => row.outcome === 'file_forgotten'),
  ).toHaveLength(3);
  refuseDelete = false;
  app.setTime(
    Math.max(...orphans.map((o) => o.uploaded.getTime())) + 3_600_001,
  );
  expect((await app.sweep()).status).toBe(204);
  expect(await fileObjects(app)).toEqual([]);
});
it('E22: an aborting file-forgotten audit insert rolls back memory, versions and file deletion in the same batch', async () => {
  app = await filesRuntime();
  const machine = await seedFileMemory(app);
  await attachFile(app, machine.token);
  const before = await fileSnapshot(app);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare(
      "CREATE TRIGGER fail_file_forget BEFORE INSERT ON audit_entries WHEN NEW.outcome='file_forgotten' BEGIN SELECT RAISE(ABORT,'synthetic attachment audit failure'); END",
    )
    .run();
  const result = await forget();
  expect(result.isError).toBe(true);
  expect(result.content).toEqual([
    { type: 'text', text: 'Service unavailable. Try again later.' },
  ]);
  expect(await fileSnapshot(app)).toEqual(before);
  expect(
    await db
      .prepare('SELECT current_version FROM memories WHERE id=?')
      .bind(fileMemory)
      .first(),
  ).toEqual({ current_version: 1 });
  expect(
    (
      await db
        .prepare('SELECT * FROM memory_versions WHERE memory_id=?')
        .bind(fileMemory)
        .all()
    ).results,
  ).toHaveLength(1);
});
