import { expect, it } from 'vitest';
import { SearchStandIns } from '../scripts/search-stand-ins.ts';

const values = Array(1024).fill(1);
const options = {
  topK: 50,
  returnMetadata: 'all' as const,
  filter: { bucket: { $in: ['allowed'] } },
};
it('Vectorize getByIds includes values and metadata, omits missing ids and shares delayed visibility with query', () => {
  const services = new SearchStandIns();
  const first = {
    id: 'a',
    values,
    metadata: { bucket: 'allowed', contentHash: 'first' },
  };
  services.upsert([first]);
  expect(services.getByIds(['a', 'absent'])).toEqual([]);
  services.advance();
  expect(services.getByIds(['absent', 'a'])).toEqual([first]);
  const next = {
    ...first,
    metadata: { bucket: 'allowed', contentHash: 'next' },
  };
  services.upsert([next]);
  expect(services.getByIds(['a'])).toEqual([first]);
  services.advance();
  expect(services.getByIds(['a'])).toEqual([next]);
});
it('recordings are strict: an unrecorded text fails rather than inventing semantic evidence', () => {
  const services = new SearchStandIns();
  expect(() =>
    services.run('@cf/baai/bge-m3', {
      text: ['unrecorded'],
      truncate_inputs: true,
    }),
  ).toThrow('Missing recorded embedding fixture.');
  expect(services.missing.size).toBe(1);
});
it('Vectorize evidence: visibility is delayed, filters require an index at write time, and upsert replaces metadata', () => {
  const services = new SearchStandIns();
  services.indexes.clear();
  services.upsert([
    { id: 'a', values, metadata: { bucket: 'allowed', contentHash: 'first' } },
  ]);
  services.indexes.add('bucket');
  expect(services.query(values, options).matches).toEqual([]);
  services.advance();
  expect(services.query(values, options).matches).toEqual([]);
  services.upsert([
    { id: 'a', values, metadata: { bucket: 'allowed', contentHash: 'second' } },
  ]);
  expect(services.query(values, options).matches).toEqual([]);
  services.advance();
  expect(services.query(values, options).matches).toMatchObject([
    { id: 'a', metadata: { contentHash: 'second' } },
  ]);
  services.upsert([{ id: 'a', values, metadata: { contentHash: 'third' } }]);
  services.advance();
  expect(services.query(values, options).matches).toEqual([]);
  expect(
    services.query(values, {
      topK: 50,
      filter: { unknown: { $in: ['anything'] } },
    }).matches,
  ).toEqual([]);
});
it('Vectorize evidence: dimensions, id/filter byte limits and all-metadata topK caps are enforced', () => {
  const services = new SearchStandIns();
  expect(() => services.upsert([{ id: 'x'.repeat(65), values }])).toThrow();
  expect(() => services.upsert([{ id: 'a', values: [1] }])).toThrow();
  expect(() => services.query(values, { topK: 101 })).toThrow();
  expect(() =>
    services.query(values, { topK: 51, returnMetadata: 'all' }),
  ).toThrow();
  expect(() =>
    services.query(values, { topK: 51, returnValues: true }),
  ).toThrow();
  expect(() =>
    services.query(values, {
      topK: 1,
      filter: { bucket: { $in: ['x'.repeat(2048)] } },
    }),
  ).toThrow();
  expect(services.query(values, { topK: 100 })).toMatchObject({ count: 0 });
});
it('Vectorize evidence: getByIds takes at most 20 ids and deleteByIds at most 100, rejected with code 40007', () => {
  const services = new SearchStandIns();
  const ids = (n: number) => Array.from({ length: n }, (_, i) => `id-${i}`);
  expect(services.getByIds(ids(20))).toEqual([]);
  expect(() => services.getByIds(ids(21))).toThrow(
    'too many ids in payload; max id count is 20, got 21 [code: 40007]',
  );
  expect(services.deleteByIds(ids(100))).toMatchObject({});
  expect(() => services.deleteByIds(ids(101))).toThrow(
    'max id count is 100, got 101 [code: 40007]',
  );
});
