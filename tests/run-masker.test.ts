import { expect, it, vi } from 'vitest';
import { maskedValues, masker } from '../apps/cli/src/masker.ts';

const path = 'work/acme/TOKEN';
const value = 'abcdabcdefgh';
const marker = `<nook:${path}>`;
function replaced(chunks: Uint8Array[], entries = [{ path, value }]) {
  const stream = masker(maskedValues(entries));
  return Buffer.concat([
    ...chunks.map((chunk) => Buffer.from(stream.push(chunk))),
    Buffer.from(stream.end()),
  ]);
}
it('every byte split of a value, including Unicode, is masked without leaking a prefix', () => {
  for (const text of [value, '🔐秘密-token-🔑']) {
    const bytes = Buffer.from(text);
    for (let split = 0; split <= bytes.length; split++) {
      const stream = masker(maskedValues([{ path, value: text }]));
      const first = Buffer.from(stream.push(bytes.subarray(0, split)));
      expect(first.length).toBe(
        split === bytes.length ? Buffer.byteLength(marker) : 0,
      );
      const output = Buffer.concat([
        first,
        Buffer.from(stream.push(bytes.subarray(split))),
        Buffer.from(stream.end()),
      ]);
      expect(output.equals(Buffer.from(marker))).toBe(true);
    }
  }
});
it('overlapping longer values remain whole even when a shorter value already matches a chunk', () => {
  const entries = [
    { path, value: 'abcdefgh' },
    { path: 'work/acme/LONG', value: 'abcdefghijkl' },
  ];
  expect(
    replaced(
      [Buffer.from('abcdefgh'), Buffer.from('ijkl')],
      entries,
    ).toString(),
  ).toBe('<nook:work/acme/LONG>');
});
it('an earlier possible longer match beats a contained complete match', () => {
  const entries = [
    { path, value: 'abcdefgh' },
    { path: 'work/acme/LONG', value: 'xxabcdefghzz' },
  ];
  expect(
    replaced(
      [Buffer.from('xxabcdefgh'), Buffer.from('zz')],
      entries,
    ).toString(),
  ).toBe('<nook:work/acme/LONG>');
});
it('prompt bytes pass immediately while only a possible value prefix is retained', () => {
  const stream = masker(maskedValues([{ path, value }]));
  expect(Buffer.from(stream.push(Buffer.from('Password: '))).toString()).toBe(
    'Password: ',
  );
  expect(Buffer.from(stream.push(Buffer.from('abc'))).length).toBe(0);
  expect(Buffer.from(stream.push(Buffer.from('!'))).toString()).toBe('abc!');
  expect(stream.end().length).toBe(0);
});
it('flush releases an incomplete prefix and later complete values are still masked', () => {
  const stream = masker(maskedValues([{ path, value }]));
  expect(stream.push(Buffer.from('abc')).length).toBe(0);
  expect(Buffer.from(stream.end()).toString()).toBe('abc');
  expect(Buffer.from(stream.push(Buffer.from(value))).toString()).toBe(marker);
});
it('pending bytes track unresolved input across matches, new tails, mismatches and flushes', () => {
  const bytes = Buffer.from('🔐秘密-token-🔑');
  const stream = masker(maskedValues([{ path, value: bytes.toString() }]));
  expect(stream.pendingBytes).toBe(0);
  expect(
    Buffer.from(
      stream.push(
        Buffer.concat([Buffer.from('prompt:'), bytes.subarray(0, 7)]),
      ),
    ).toString(),
  ).toBe('prompt:');
  expect(stream.pendingBytes).toBe(7);
  expect(
    Buffer.from(
      stream.push(Buffer.concat([bytes.subarray(7), bytes.subarray(0, 3)])),
    ).toString(),
  ).toBe(marker);
  expect(stream.pendingBytes).toBe(3);
  expect(
    Buffer.from(stream.push(Buffer.from('!'))).equals(
      Buffer.concat([bytes.subarray(0, 3), Buffer.from('!')]),
    ),
  ).toBe(true);
  expect(stream.pendingBytes).toBe(0);
  expect(stream.push(bytes.subarray(0, 7)).length).toBe(0);
  expect(stream.pendingBytes).toBe(7);
  expect(Buffer.from(stream.end()).equals(bytes.subarray(0, 7))).toBe(true);
  expect(stream.pendingBytes).toBe(0);
});
it('duplicates pick the first path, seven code points are skipped and eight survive', () => {
  const entries = [
    { path: 'work/acme/Z', value },
    { path, value },
    { path: 'work/acme/A', value },
    { path, value: '🔐'.repeat(7) },
  ];
  expect(replaced([Buffer.from(value)], entries).toString()).toBe(
    '<nook:work/acme/A>',
  );
  expect(maskedValues([{ path, value: '🔐'.repeat(7) }])).toHaveLength(0);
  expect(maskedValues([{ path, value: '🔐'.repeat(8) }])).toHaveLength(1);
});
it('plain binary bytes, repeated matches, and marker-looking output stay byte exact', () => {
  const binary = Buffer.from(Array.from({ length: 256 }, (_, i) => i));
  const actual = replaced([binary, Buffer.from(value + value + marker)]);
  expect(
    actual.equals(Buffer.concat([binary, Buffer.from(marker.repeat(3))])),
  ).toBe(true);
});
it('EOF masks a complete shorter value held for a possible longer value', () => {
  const entries = [
    { path, value: 'abcdefgh' },
    { path: 'work/acme/LONG', value: 'abcdefghijkl' },
  ];
  expect(replaced([Buffer.from('abcdefgh')], entries).toString()).toBe(marker);
});
it('repeated matches search absent values only once per chunk', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    path: `work/acme/VALUE_${i}`,
    value: 'a'.repeat(8) + (i ? String.fromCharCode(65 + i) : ''),
  }));
  const stream = masker(maskedValues(entries));
  const chunk = Buffer.alloc(65_536, 'a');
  const matches = chunk.length / 8;
  const budget = matches + entries.length;
  let calls = 0;
  const indexOf = Buffer.prototype.indexOf;
  const search = vi
    .spyOn(Buffer.prototype, 'indexOf')
    .mockImplementation(function (this: Buffer, ...args) {
      if (++calls > budget)
        throw new Error('Full-match search exceeded its indexOf call budget.');
      return indexOf.apply(this, args);
    });
  let output: Uint8Array;
  try {
    output = stream.push(chunk);
  } finally {
    search.mockRestore();
  }
  expect(calls).toBeGreaterThanOrEqual(entries.length);
  expect(Buffer.concat([output, stream.end()]).toString()).toBe(
    '<nook:work/acme/VALUE_0>'.repeat(matches),
  );
});
it('adversarial long prefixes stay within a linear tail-search budget', () => {
  const entries = Array.from({ length: 20 }, (_, i) => ({
    path: `work/acme/VALUE_${i}`,
    value: 'a'.repeat(65_534) + String.fromCharCode(66 + i),
  }));
  const chunk = Buffer.from('a'.repeat(65_535) + '!');
  // Count KMP failure-link reads and bulk-comparison bytes, including the
  // old suffix search's repeated equals() scans, without timing the search.
  const budget = 4 * entries.length * chunk.length;
  let work = 0;
  function count(amount: number) {
    work += amount;
    if (work > budget)
      throw new Error('Prefix search exceeded a linear tail-search budget.');
  }
  const values = maskedValues(entries).map((value) => ({
    ...value,
    prefixes: new Proxy(value.prefixes, {
      get(table, key) {
        count(1);
        return Reflect.get(table, key, table);
      },
    }),
  }));
  const stream = masker(values);
  const equals = Buffer.prototype.equals;
  const bulk = vi
    .spyOn(Buffer.prototype, 'equals')
    .mockImplementation(function (this: Buffer, ...args: unknown[]) {
      const other = args[0] as Uint8Array;
      count(Math.min(this.length, other.length));
      return equals.call(this, other);
    });
  let output: Uint8Array;
  try {
    output = stream.push(chunk);
  } finally {
    bulk.mockRestore();
  }
  expect(work).toBeGreaterThan(0);
  expect(Buffer.from(output).equals(chunk)).toBe(true);
  expect(stream.end().length).toBe(0);
});
it('replacements discard overlapping tail candidates before holding the next prefix', () => {
  const stream = masker(maskedValues([{ path, value: 'a'.repeat(8) }]));
  expect(Buffer.from(stream.push(Buffer.from('a'.repeat(26)))).toString()).toBe(
    marker.repeat(3),
  );
  expect(Buffer.from(stream.push(Buffer.from('a'.repeat(6)))).toString()).toBe(
    marker,
  );
  expect(stream.end().length).toBe(0);
});
