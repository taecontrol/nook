import { expect, it } from 'vitest';
import { SearchStandIns } from '../scripts/search-stand-ins.ts';

const values = Array(1024).fill(1);
const options = {
  topK: 50,
  returnMetadata: 'all' as const,
  filter: { bucket: { $in: ['allowed'] } },
};
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
it('Vectorize evidence: visibility is delayed, filters require an index at write time, insert is inert, and upsert replaces metadata', () => {
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
  services.insert([{ id: 'a', values, metadata: { bucket: 'denied' } }]);
  services.advance();
  expect(services.query(values, options).matches).toHaveLength(1);
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
