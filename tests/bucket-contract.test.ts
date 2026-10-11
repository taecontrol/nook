import { Schema } from 'effect';
import { expect, it } from 'vitest';
import {
  BucketPath,
  canRead,
  canWrite,
} from '../packages/contract/src/index.ts';
import { invalidPaths, validPaths } from './support/bucket-paths.ts';

it.each(validPaths)('E1: the contract accepts %s', (path) => {
  expect(Schema.decodeUnknownSync(BucketPath)(path)).toBe(path);
});
it.each(invalidPaths)(
  'E1: the contract rejects %s with its exact message',
  (path, message) => {
    expect(() => Schema.decodeUnknownSync(BucketPath)(path)).toThrow(message);
  },
);
it.each([
  ['work/acme', true, true],
  ['work/acme/x', true, true],
  ['work', true, false],
  ['me', true, false],
  ['personal', false, false],
  ['work/other', false, false],
  ['workshop', false, false],
])('E2: grant work/acme authorizes %s correctly', (path, read, write) => {
  expect(canRead(['work/acme'], String(path))).toBe(read);
  expect(canWrite(['work/acme'], String(path))).toBe(write);
});
it.each(['workshop', 'work-archive'])(
  'E3: a work grant denies a prefix neighbor %s',
  (path) => {
    expect(canRead(['work'], path)).toBe(false);
    expect(canWrite(['work'], path)).toBe(false);
  },
);
it.each(validPaths)('E4: all buckets allows read and write to %s', (path) => {
  expect(canRead('all', path)).toBe(true);
  expect(canWrite('all', path)).toBe(true);
});
