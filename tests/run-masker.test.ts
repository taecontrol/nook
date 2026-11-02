import { expect, it } from 'vitest';
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
