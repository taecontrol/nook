import { createHash, randomUUID } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { handlerForPrincipal } from '../apps/worker/src/index.ts';
import { expectToolError } from './support/mcp.ts';
import {
  listMemoryPage,
  manyMemories,
  memoryClient,
  memoryCounts,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
  typicalMemories,
} from './support/memory.ts';
import type { TestRuntime } from './support/runtime.ts';
import { vaultCheckpoints } from './support/vault-checkpoints.ts';

let app: TestRuntime;
beforeAll(async () => {
  app = await memoryRuntime();
});
beforeEach(async () => {
  const db = await app.mf.getD1Database('DB');
  await db.prepare('DELETE FROM memories').run();
});
afterAll(() => app?.close());
const deleteBucket = (path: string) =>
  fetch(`${app.origin}/api/buckets/${encodeURIComponent(path)}`, {
    method: 'DELETE',
  });

it('E17: the owner feed merges only the lineage newest first and never sends content', async () => {
  await seedMemories(app, [
    ...typicalMemories,
    memoryFixture(8, {
      bucket: 'personal',
      content: 'synthetic-private-personal-memory',
    }),
    memoryFixture(9, { bucket: 'work/acme/api' }),
  ]);
  const page = await listMemoryPage(app);
  expect(page.memories.map((m) => m.id)).toEqual(
    [1, 2, 4, 6, 3, 5, 7].map(memoryId),
  );

  expect(page.memories.map((m) => m.bucket)).toEqual([
    'work/acme',
    'work/acme',
    'work',
    'me',
    'work/acme',
    'work',
    'me',
  ]);
  expect(page.memories[0]).toMatchObject({
    title: 'Release process',
    tags: ['deploy', 'release-process', 'cli'],
    provenance: {
      client: { name: 'claude-code', version: '2.1.295' },
      principal: { kind: 'machine', name: 'luis-mbp' },
      workingDirectory: '/Users/luis/code/acme-api',
    },
  });
  expect(page.next).toBeNull();
  expect(page.memories.every((m) => !('content' in m) && !('seq' in m))).toBe(
    true,
  );
  expect(JSON.stringify(page)).not.toContain(
    'synthetic-private-personal-memory',
  );
});
it('E22: tree counts are per bucket, include empty buckets and exclude paths outside the read grant', async () => {
  await seedMemories(app, [
    ...typicalMemories,
    memoryFixture(8, { bucket: 'personal' }),
  ]);
  const response = await fetch(`${app.origin}/api/memories/counts`);
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({
    counts: [
      { bucket: 'me', count: 2 },
      { bucket: 'personal', count: 1 },
      { bucket: 'work', count: 2 },
      { bucket: 'work/acme', count: 3 },
      { bucket: 'work/acme/api', count: 0 },
    ],
  });
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work'],
  );
  const restricted = await handler(
    new Request('http://nook.test/api/memories/counts'),
  );
  expect(restricted.status).toBe(200);
  expect(JSON.stringify(await restricted.json())).not.toContain('personal');
});

it('E18: tied creation times page 25/25/25/15 without gaps or repeats and reject modified or cross-bucket cursors', async () => {
  const seeds = manyMemories.map((m) => ({
    ...m,
    createdAt: '2026-10-09T14:00:00.000Z',
  }));
  await seedMemories(app, seeds);
  const ids: string[] = [];
  const lengths: number[] = [];
  let next: string | null = null;
  let firstCursor = '';
  do {
    const page = await listMemoryPage(
      app,
      `bucket=work/acme${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
    );
    lengths.push(page.memories.length);
    ids.push(...page.memories.map((m) => m.id));
    next = page.next;
    firstCursor ||= next ?? '';
  } while (next);
  expect(lengths).toEqual([25, 25, 25, 15]);
  expect(ids).toEqual(
    seeds
      .map((m) => m.id)
      .sort()
      .reverse(),
  );
  expect(new Set(ids).size).toBe(90);
  for (const query of [
    `bucket=work/acme&cursor=${encodeURIComponent(`${firstCursor}x`)}`,
    `bucket=personal&cursor=${encodeURIComponent(firstCursor)}`,
    `bucket=work/acme&scope=bucket&cursor=${encodeURIComponent(firstCursor)}`,
  ]) {
    const response = await fetch(`${app.origin}/api/memories?${query}`);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: 'InvalidMemoryCursor',
    });
  }
});
it('E19: bucket-only paging excludes ancestors with the same ordering and page size', async () => {
  await seedMemories(app, manyMemories);
  const all = [];
  const lengths = [];
  let next: string | null = null;
  do {
    const page = await listMemoryPage(
      app,
      `bucket=work/acme&scope=bucket${next ? `&cursor=${encodeURIComponent(next)}` : ''}`,
    );
    expect(page.memories.every((m) => m.bucket === 'work/acme')).toBe(true);
    lengths.push(page.memories.length);
    all.push(...page.memories.map((m) => m.id));
    next = page.next;
  } while (next);
  expect(lengths).toEqual([25, 25, 10]);
  expect(all).toEqual(manyMemories.slice(0, 60).map((m) => m.id));
});
it('E18: an issued cursor rejects a change to another existing ordering pair without skipping its memory', async () => {
  const at = '2026-10-09T14:00:00.000Z';
  await seedMemories(
    app,
    manyMemories.map((memory) => ({ ...memory, createdAt: at })),
  );
  const first = await listMemoryPage(app);
  expect(first.memories.map((memory) => memory.id)).toEqual(
    Array.from({ length: 25 }, (_, index) => memoryId(189 - index)),
  );
  expect(first.next).toBeTypeOf('string');
  const issued = first.next as string;
  const second = await listMemoryPage(
    app,
    `bucket=work/acme&cursor=${encodeURIComponent(issued)}`,
  );
  expect(second.memories.map((memory) => memory.id)).toEqual(
    Array.from({ length: 25 }, (_, index) => memoryId(164 - index)),
  );
  const modified = JSON.parse(
    Buffer.from(issued, 'base64url').toString('utf8'),
  );
  expect(modified).toMatchObject({
    bucket: 'work/acme',
    scope: 'inherited',
    at,
    id: memoryId(165),
  });
  modified.id = memoryId(164);
  const cursor = Buffer.from(JSON.stringify(modified)).toString('base64url');
  const response = await fetch(
    `${app.origin}/api/memories?bucket=work/acme&cursor=${encodeURIComponent(cursor)}`,
  );
  expect(response.status).toBe(400);
  expect(await response.json()).toMatchObject({ _tag: 'InvalidMemoryCursor' });
});
it('E18/E19: cursors reject mismatched scope, malformed encodings and fabricated native ordering pairs', async () => {
  const at = '2026-10-09T14:00:00.000Z';
  await seedMemories(app, [
    ...manyMemories.map((memory) => ({ ...memory, createdAt: at })),
    memoryFixture(1, { bucket: 'personal', createdAt: at }),
  ]);
  const own = await listMemoryPage(app, 'bucket=work/acme&scope=bucket');
  expect(own.next).toBeTypeOf('string');
  const encodedPair = (id: unknown, time: string) => {
    const payload = { bucket: 'work/acme', scope: 'inherited', at: time, id };
    const checksum = createHash('sha256')
      .update(JSON.stringify(payload))
      .digest('hex');
    return Buffer.from(JSON.stringify({ v: 1, ...payload, checksum })).toString(
      'base64url',
    );
  };
  const page = await listMemoryPage(app);
  const issued = page.next as string;
  const malformed = [
    '',
    'x'.repeat(1025),
    Buffer.from('{').toString('base64url'),
    `${issued}=`,
    Buffer.from(
      JSON.stringify(
        JSON.parse(Buffer.from(issued, 'base64url').toString('utf8')),
        null,
        1,
      ),
    ).toString('base64url'),
    own.next as string,
    encodedPair(randomUUID(), at),
    encodedPair(memoryId(165), '2026-10-09T23:00:00.000Z'),
    encodedPair(memoryId(1), at),
    encodedPair([memoryId(165)], at),
    encodedPair(memoryId(165), '2026-10-09T14:00:00Z'),
    encodedPair('malformed', at),
  ];
  for (const cursor of malformed) {
    const response = await fetch(
      `${app.origin}/api/memories?bucket=work/acme&cursor=${encodeURIComponent(cursor)}`,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      _tag: 'InvalidMemoryCursor',
    });
  }
  const db = await app.mf.getD1Database('DB');
  await db.prepare('ALTER TABLE memories RENAME TO unavailable_memories').run();
  try {
    const valid = await fetch(
      `${app.origin}/api/memories?bucket=work/acme&cursor=${encodeURIComponent(issued)}`,
    );
    expect(valid.status).toBe(503);
    expect(await valid.json()).toEqual({ _tag: 'ServiceUnavailable' });
    for (const cursor of [
      encodedPair('malformed', at),
      encodedPair(memoryId(165), '2026-10-09T14:00:00Z'),
      encodedPair([memoryId(165)], at),
    ]) {
      const response = await fetch(
        `${app.origin}/api/memories?bucket=work/acme&cursor=${encodeURIComponent(cursor)}`,
      );
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        _tag: 'InvalidMemoryCursor',
      });
    }
  } finally {
    await db
      .prepare('ALTER TABLE unavailable_memories RENAME TO memories')
      .run();
  }
});
it('E20/E33: restricted handlers forbid sibling lists and mask detail; the owner routes reject Nook tokens', async () => {
  await seedMemories(app, [
    memoryFixture(1, {
      bucket: 'personal',
      content: 'synthetic-private-personal-memory',
    }),
    memoryFixture(2, { bucket: 'me' }),
  ]);
  const handler = handlerForPrincipal(
    'owner@nook.test',
    await app.mf.getD1Database('DB'),
    ['work'],
  );
  for (const [path, status] of [
    ['/api/memories?bucket=personal', 403],
    [`/api/memories/${memoryId(1)}`, 404],
    [`/api/memories/${randomUUID()}`, 404],
    ['/api/memories/malformed', 404],
  ] as const) {
    const response = await handler(new Request(`http://nook.test${path}`));
    expect(response.status).toBe(status);
    expect(await response.text()).not.toContain(
      'synthetic-private-personal-memory',
    );
  }
  const allowed = await handler(
    new Request(`http://nook.test/api/memories/${memoryId(2)}`),
  );
  expect(allowed.status).toBe(200);
  // Remove only the local owner bypass: a Nook bearer cannot stand in for Access.
  await app.setBindings({});
  try {
    for (const path of [
      '/api/memories?bucket=work',
      `/api/memories/${memoryId(2)}`,
    ]) {
      const rejected = await fetch(`${app.origin}${path}`, {
        headers: { Authorization: 'Bearer synthetic-nook-credential' },
      });
      expect(rejected.status).toBe(401);
      expect(await rejected.text()).not.toContain('synthetic-nook-credential');
    }
  } finally {
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
    });
  }
});
it.each([
  ['\n\n## Release process\nSteps…', 'Release process'],
  ['\r\r## CR release\rSecond line', 'CR release'],
  ['\r\n\r\n## CRLF release\r\nSecond line', 'CRLF release'],
  [' > - * ## Prefer pnpm  \nDetails', 'Prefer pnpm'],
  ['a'.repeat(121), 'a'.repeat(120)],
  ['😀'.repeat(121), '😀'.repeat(120)],
  [' > - * ##   \nDetails', 'Untitled memory'],
  [`${'\n'.repeat(600)}## After blank lines\nDetails`, 'After blank lines'],
])(
  'E21: title derives from the first nonblank line of %j',
  async (content, title) => {
    await seedMemories(app, [memoryFixture(1, { content })]);
    expect((await listMemoryPage(app)).memories[0].title).toBe(title);
  },
);
it('E17: list inherits bucket grammar and a valid missing bucket stays not found', async () => {
  await seedMemories(app, typicalMemories);
  for (const [bucket, status, tag] of [
    ['WORK', 400, 'InvalidBucketPath'],
    ['work/missing', 404, 'BucketNotFound'],
  ] as const) {
    const response = await fetch(`${app.origin}/api/memories?bucket=${bucket}`);
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ _tag: tag });
  }
});
it('E9/E14: a malformed id remains not found while memory storage is unavailable', async () => {
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
    .run();
  try {
    const response = await fetch(`${app.origin}/api/memories/malformed`);
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ _tag: 'MemoryNotFound' });
  } finally {
    await db
      .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
      .run();
  }
});
it('storage reads: get and list use the persisted current version and its provenance', async () => {
  await seedMemories(app, [memoryFixture(1)]);
  const db = await app.mf.getD1Database('DB');
  const content = '# Current version\nThe current body.';
  const at = '2026-10-09T20:00:00.000Z';
  await db
    .prepare(
      'INSERT INTO memory_versions(memory_id,version,content,tags,client_name,client_version,principal,machine_id,machine_name,working_directory,created_at) SELECT memory_id,2,?,\'["current"]\',client_name,client_version,principal,machine_id,machine_name,working_directory,? FROM memory_versions WHERE memory_id=?',
    )
    .bind(content, at, memoryId(1))
    .run();
  await db
    .prepare(
      'UPDATE memories SET current_version=2, content_hash=?, updated_at=? WHERE id=?',
    )
    .bind(createHash('sha256').update(content).digest('hex'), at, memoryId(1))
    .run();
  const detail = await memoryClient(app, '2026-07-28').call('get', {
    id: memoryId(1),
  });
  expect(detail.structuredContent).toMatchObject({
    content,
    tags: ['current'],
    version: 2,
    updatedAt: at,
    provenance: { at },
  });
  expect((await listMemoryPage(app)).memories).toEqual([
    expect.objectContaining({
      title: 'Current version',
      tags: ['current'],
      version: 2,
      provenance: expect.objectContaining({ at }),
    }),
  ]);
});
it('E5/E14/E33: a hash-conflict row with different bytes fails privately without changing either memory', async () => {
  const stored = memoryFixture(1, {
    content: 'synthetic-existing-conflict-content',
  });
  const submitted = 'synthetic-submitted-conflict-content';
  await seedMemories(app, [stored]);
  const db = await app.mf.getD1Database('DB');
  // Seed the storage state a hash collision presents; no crypto replacement.
  await db
    .prepare('UPDATE memories SET content_hash=? WHERE id=?')
    .bind(createHash('sha256').update(submitted).digest('hex'), stored.id)
    .run();
  const result = await memoryClient(app, '2026-07-28').call('remember', {
    bucket: stored.bucket,
    content: submitted,
  });
  expectToolError(result, 'Service unavailable. Try again later.');
  expect(JSON.stringify(result)).not.toContain(stored.content);
  expect(JSON.stringify(result)).not.toContain(submitted);
  expect(await memoryCounts(app)).toEqual({ memories: 1, versions: 1 });
  expect(
    (await memoryClient(app, '2026-07-28').call('get', { id: stored.id }))
      .structuredContent?.content,
  ).toBe(stored.content);
});
it('E18: a terminal page with exactly 25 memories has no next cursor', async () => {
  await seedMemories(app, manyMemories.slice(0, 25));
  const page = await listMemoryPage(app);
  expect(page.memories).toHaveLength(25);
  expect(page.next).toBeNull();
});
it('Memory SQL budgets: remember uses one batch, get one statement and each feed page one batch', async () => {
  const labels: string[] = [];
  const measured = await vaultCheckpoints(
    async (label) => {
      labels.push(label);
      return true;
    },
    undefined,
    false,
    { observeBatchSize: true },
  );
  try {
    await seedMemories(measured, manyMemories);
    const client = memoryClient(measured, '2026-07-28');
    const write = await client.call('remember', {
      bucket: 'work/acme',
      content: '# Statement budget\nOne atomic write batch.',
    });
    expect(write.isError).not.toBe(true);
    expect(labels).toEqual(['/before-batch', '/batch-3', '/after-batch']);
    labels.length = 0;
    const retry = await client.call('remember', {
      bucket: 'work/acme',
      content: '# Statement budget\nOne atomic write batch.',
    });
    expect(retry.structuredContent).toMatchObject({ created: false });
    expect(labels).toEqual(['/before-batch', '/batch-3', '/after-batch']);
    labels.length = 0;
    const detail = await client.call('get', {
      id: write.structuredContent?.id,
    });
    expect(detail.structuredContent).toMatchObject({
      content: '# Statement budget\nOne atomic write batch.',
    });
    expect(labels).toEqual(['/statement']);
    labels.length = 0;
    const first = await listMemoryPage(measured);
    expect(first.memories).toHaveLength(25);
    expect(first.next).not.toBeNull();
    expect(labels).toEqual(['/before-batch', '/batch-2', '/after-batch']);
    labels.length = 0;
    const second = await listMemoryPage(
      measured,
      `bucket=work/acme&cursor=${encodeURIComponent(first.next ?? '')}`,
    );
    expect(second.memories).toHaveLength(25);
    expect(labels).toEqual(['/before-batch', '/batch-2', '/after-batch']);
    labels.length = 0;
    expect((await fetch(`${measured.origin}/api/memories/counts`)).status).toBe(
      200,
    );
    expect(labels).toEqual(['/statement']);
  } finally {
    await measured.close();
  }
});
it('E15: HTTP and MCP refuse a memory bucket and SQL foreign keys prevent orphans', async () => {
  await seedMemories(app, [memoryFixture(1)]);
  const response = await deleteBucket('work/acme');
  expect(response.status).toBe(409);
  expect(await response.json()).toEqual({
    _tag: 'BucketHasChildren',
    message: 'Delete its child buckets first.',
  });
  expect((await deleteBucket('work/acme/api')).status).toBe(204);
  const leaf = await deleteBucket('work/acme');
  expect(leaf.status).toBe(409);
  expect(await leaf.json()).toEqual({
    _tag: 'BucketHasMemories',
    message: 'Delete its memories first.',
  });
  expectToolError(
    await memoryClient(app, '2026-07-28').call('delete_bucket', {
      path: 'work/acme',
    }),
    'Delete its memories first.',
  );
  const db = await app.mf.getD1Database('DB');
  await expect(
    db.prepare("DELETE FROM buckets WHERE path='work/acme'").run(),
  ).rejects.toThrow(/FOREIGN KEY/i);
  expect(await memoryCounts(app)).toEqual({ memories: 1, versions: 1 });
  await db
    .prepare("INSERT INTO buckets VALUES ('work/acme/api','2026-10-09')")
    .run();
});
it('E15: secret blockers precede memories after the child blocker', async () => {
  const db = await app.mf.getD1Database('DB');
  await seedMemories(app, [memoryFixture(1)]);
  await db
    .prepare(
      "INSERT INTO secrets(bucket,name,description,version,key_id,iv,ciphertext,created_at,updated_at) VALUES ('work/acme','SYNTHETIC_KEY','','synthetic-version','0000000000000000','0000000000000000','00000000000000000000000','2026-10-09','2026-10-09')",
    )
    .run();
  try {
    expect(await (await deleteBucket('work/acme')).json()).toMatchObject({
      _tag: 'BucketHasChildren',
    });
    await deleteBucket('work/acme/api');
    expect(await (await deleteBucket('work/acme')).json()).toEqual({
      _tag: 'BucketHasSecrets',
      message: 'Delete its secrets first.',
    });
  } finally {
    await db.prepare("DELETE FROM secrets WHERE bucket='work/acme'").run();
    await db
      .prepare(
        "INSERT OR IGNORE INTO buckets VALUES ('work/acme/api','2026-10-09')",
      )
      .run();
  }
});
it.each(['remember-first', 'delete-first', 'concurrent'] as const)(
  'E16: %s deletion and remember cannot produce an orphan',
  async (order) => {
    const client = memoryClient(app, '2026-07-28');
    const bucket = `work/race-${order}`;
    await client.call('create_bucket', { path: bucket });
    const remember = () =>
      client.call('remember', { bucket, content: '# Race fixture' });
    const remove = () => deleteBucket(bucket);
    const [write, deletion] =
      order === 'remember-first'
        ? [await remember(), await remove()]
        : order === 'delete-first'
          ? await (async () => {
              const deleted = await remove();
              return [await remember(), deleted] as const;
            })()
          : await Promise.all([remember(), remove()]);
    if (write.isError) {
      expectToolError(write, 'Bucket not found.');
      expect(deletion.status).toBe(204);
    } else {
      expect(write.structuredContent?.created).toBe(true);
      expect(deletion.status).toBe(409);
      expect(await deletion.json()).toMatchObject({
        _tag: 'BucketHasMemories',
      });
    }
    const db = await app.mf.getD1Database('DB');
    expect(
      await db
        .prepare(
          'SELECT count(*) AS n FROM memories m LEFT JOIN buckets b ON b.path=m.bucket WHERE b.path IS NULL',
        )
        .first('n'),
    ).toBe(0);
  },
);
it('schema: the unique index and version checks independently enforce the settled storage contract', async () => {
  await seedMemories(app, [memoryFixture(1)]);
  const db = await app.mf.getD1Database('DB');
  await expect(
    db
      .prepare(
        'INSERT INTO memories(id,bucket,current_version,content_hash,created_at,updated_at) SELECT ?,bucket,current_version,content_hash,created_at,updated_at FROM memories WHERE id=?',
      )
      .bind(randomUUID(), memoryId(1))
      .run(),
  ).rejects.toThrow(/UNIQUE/i);
  for (const query of [
    "UPDATE memory_versions SET principal='owner' WHERE memory_id=?",
    'UPDATE memory_versions SET tags=\'["a","b","c","d","e","f","g","h","i","j","k"]\' WHERE memory_id=?',
  ])
    await expect(db.prepare(query).bind(memoryId(1)).run()).rejects.toThrow(
      /CHECK/i,
    );
});
it('schema: native D1 rejects invalid head, version, client and tag facts', async () => {
  await seedMemories(app, [memoryFixture(1)]);
  const db = await app.mf.getD1Database('DB');
  const invalidFacts: [string, string | number][] = [
    ['UPDATE memories SET current_version=? WHERE id=?', 0],
    ['UPDATE memories SET content_hash=? WHERE id=?', 'not-a-hash'],
    ['UPDATE memories SET content_hash=? WHERE id=?', 'A'.repeat(64)],
    ['UPDATE memory_versions SET version=? WHERE memory_id=?', 0],
    ['UPDATE memory_versions SET content=? WHERE memory_id=?', ''],
    [
      'UPDATE memory_versions SET content=? WHERE memory_id=?',
      'é'.repeat(8192) + 'a',
    ],
    ['UPDATE memory_versions SET tags=? WHERE memory_id=?', '{"a":"b"}'],
    ['UPDATE memory_versions SET client_name=? WHERE memory_id=?', ''],
    [
      'UPDATE memory_versions SET client_name=? WHERE memory_id=?',
      'a'.repeat(129),
    ],
    ['UPDATE memory_versions SET client_version=? WHERE memory_id=?', ''],
    [
      'UPDATE memory_versions SET client_version=? WHERE memory_id=?',
      '1'.repeat(65),
    ],
    ['UPDATE memory_versions SET principal=? WHERE memory_id=?', 'other'],
  ];
  for (const [query, value] of invalidFacts)
    await expect(
      db.prepare(query).bind(value, memoryId(1)).run(),
    ).rejects.toThrow(/CHECK/i);
  await expect(
    db
      .prepare(
        'INSERT INTO memories(id,bucket,current_version,content_hash,created_at,updated_at) VALUES (?,?,1,?,?,?)',
      )
      .bind(
        'bad',
        'work/acme',
        '0'.repeat(64),
        '2026-10-09T20:00:00.000Z',
        '2026-10-09T20:00:00.000Z',
      )
      .run(),
  ).rejects.toThrow(/CHECK/i);
  await expect(
    db
      .prepare(
        'INSERT INTO memory_versions SELECT * FROM memory_versions WHERE memory_id=?',
      )
      .bind(memoryId(1))
      .run(),
  ).rejects.toThrow(/UNIQUE/i);
});
it('schema: removing a memory head cascades to its stored versions', async () => {
  await seedMemories(app, [memoryFixture(1)]);
  const db = await app.mf.getD1Database('DB');
  await db.prepare('DELETE FROM memories WHERE id=?').bind(memoryId(1)).run();
  expect(await memoryCounts(app)).toEqual({ memories: 0, versions: 0 });
});
it('E14/E33: failed HTTP reads have fixed public errors with no title, content or storage cause', async () => {
  await seedMemories(app, [
    memoryFixture(1, { content: 'synthetic-private-personal-memory' }),
  ]);
  const db = await app.mf.getD1Database('DB');
  await db
    .prepare('ALTER TABLE memory_versions RENAME TO unavailable_versions')
    .run();
  try {
    for (const path of [
      '/api/memories?bucket=work/acme',
      `/api/memories/${memoryId(1)}`,
    ]) {
      const response = await fetch(`${app.origin}${path}`);
      expect(response.status).toBe(503);
      expect(await response.json()).toEqual({ _tag: 'ServiceUnavailable' });
    }
  } finally {
    await db
      .prepare('ALTER TABLE unavailable_versions RENAME TO memory_versions')
      .run();
  }
});
