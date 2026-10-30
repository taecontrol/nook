import { readdir } from 'node:fs/promises';
import { expect, it } from 'vitest';
import { assignShards, bySlowest } from '../scripts/lib/test-shards.ts';

const testFiles = async () =>
  (await readdir('tests'))
    .filter((name) => name.endsWith('.test.ts'))
    .map((name) => `tests/${name}`);

it('every test file runs in exactly one of the ten CI shards', async () => {
  const files = await testFiles();
  const shards = assignShards(files, 10);
  expect(shards).toHaveLength(10);
  expect(shards.flat().sort()).toEqual([...files].sort());
  for (const shard of shards) expect(shard.length).toBeGreaterThan(0);
});

it('each shard job derives the same assignment whatever order vitest lists files in', async () => {
  const files = await testFiles();
  expect(assignShards([...files].reverse(), 10)).toEqual(
    assignShards(files, 10),
  );
});

it('two slow suites never share a shard while a lighter shard exists', () => {
  const table = {
    'a.ts': 400,
    'b.ts': 300,
    'c.ts': 20,
    'd.ts': 10,
    'e.ts': 10,
  };
  const shards = assignShards(Object.keys(table), 2, table);
  expect(shards).toEqual([['a.ts'], ['b.ts', 'c.ts', 'd.ts', 'e.ts']]);
});

it('a file the table has not measured counts as the median measured file', () => {
  const table = { 'slow.ts': 90, 'mid.ts': 30, 'fast.ts': 5 };
  expect(bySlowest(['fast.ts', 'new.ts', 'slow.ts', 'mid.ts'], table)).toEqual([
    'slow.ts',
    'mid.ts',
    'new.ts',
    'fast.ts',
  ]);
  expect(assignShards(['new.ts'], 2, {})).toEqual([['new.ts'], []]);
});
