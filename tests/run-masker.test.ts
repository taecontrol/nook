import { expect, it, vi } from 'vitest';
import { maskedValues, masker } from '../apps/cli/src/masker.ts';

const path = 'work/acme/TOKEN';
const value = 'abcdabcdefgh';
const marker = `<nook:${path}>`;
function referenceMask(
  data: Buffer,
  entries: { path: string; value: string }[],
) {
  const values = entries
    .filter(({ value }) => [...value].length >= 8)
    .map(({ path, value }) => ({ path, bytes: Buffer.from(value) }))
    .sort(
      (a, b) =>
        b.bytes.length - a.bytes.length ||
        (a.path < b.path ? -1 : a.path > b.path ? 1 : 0),
    );
  const output: Buffer[] = [];
  for (let at = 0; at < data.length; ) {
    const match = values.find(({ bytes }) =>
      data.subarray(at, at + bytes.length).equals(bytes),
    );
    if (match) {
      output.push(Buffer.from(`<nook:${match.path}>`));
      at += match.bytes.length;
    } else {
      output.push(data.subarray(at, at + 1));
      at++;
    }
  }
  return Buffer.concat(output);
}
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
it('overlapping cached matches stay within capped native and linear KMP search budgets', () => {
  const chunk = Buffer.alloc(65_536, 'abcdefghi');
  const entries = [
    { path, value: 'abcdefgh' },
    ...Array.from({ length: 19 }, (_, i) => ({
      path: `work/acme/VALUE_${i}`,
      value: chunk.subarray(1, 32_769 - i).toString(),
    })),
  ];
  const expected = referenceMask(chunk, entries);
  const searchBudget = (16 + 1) * entries.length;
  const prefixBudget = 4 * entries.length * chunk.length;
  let searches = 0;
  let prefixes = 0;
  const values = maskedValues(entries).map((value) => ({
    ...value,
    prefixes: new Proxy(value.prefixes, {
      get(table, key) {
        if (++prefixes > prefixBudget)
          throw new Error('Full-match KMP search exceeded its linear budget.');
        return Reflect.get(table, key, table);
      },
    }),
  }));
  const stream = masker(values);
  const indexOf = Buffer.prototype.indexOf;
  const search = vi
    .spyOn(Buffer.prototype, 'indexOf')
    .mockImplementation(function (this: Buffer, ...args) {
      if (++searches > searchBudget)
        throw new Error('Overlapping matches exceeded their indexOf budget.');
      return indexOf.apply(this, args);
    });
  let output: Buffer;
  try {
    output = Buffer.concat([stream.push(chunk), stream.end()]);
  } finally {
    search.mockRestore();
  }
  expect(searches).toBeGreaterThanOrEqual(entries.length);
  expect(prefixes).toBeGreaterThan(0);
  expect(output.equals(expected)).toBe(true);
});
it.each([false, true])(
  'overlapping full matches retain their failure-link seed (held until final: %s)',
  (final) => {
    const long = 'a'.repeat(32);
    const short = `b${'a'.repeat(7)}`;
    const repeated = `b${'a'.repeat(40)}!`;
    const data = Buffer.from(`${long}!${repeated.repeat(20)}`);
    const entries = [
      { path, value: long },
      { path: 'work/acme/SHORT', value: short },
      ...(final
        ? [{ path: 'work/acme/HOLD', value: `${data.toString()}?` }]
        : []),
    ];
    const expected = referenceMask(data, entries);
    for (const split of [1, 31, 33, 97, data.length - 1, 0, data.length]) {
      const stream = masker(maskedValues(entries));
      const output = [
        stream.push(data.subarray(0, split)),
        stream.push(data.subarray(split)),
      ];
      if (final) expect(stream.pendingBytes).toBe(data.length);
      output.push(stream.end());
      expect(Buffer.concat(output).equals(expected), `split ${split}`).toBe(
        true,
      );
    }
  },
);
it('randomized binary-alphabet chunks match a whole-buffer reference across the search cap and held tails', () => {
  let seed = 0x80abcdef;
  function random(limit: number) {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed >>> 0) % limit;
  }
  const text = (length: number) =>
    Array.from({ length }, () => (random(2) ? 'a' : 'b')).join('');
  for (let sample = 0; sample < 80; sample++) {
    // Offset periodic values force repeated invalidations beyond the cap.
    const first = random(2) ? 'a' : 'b';
    const unit = first + (first === 'a' ? 'b' : 'a').repeat(1 + random(4));
    const short = unit.repeat(Math.ceil(8 / unit.length));
    const long = unit.repeat(16 + random(16)).slice(1);
    const entries = [
      { path, value: short },
      { path: 'work/acme/LONG', value: long },
      { path: 'work/acme/DUPLICATE', value: long },
      ...Array.from({ length: 1 + random(4) }, (_, i) => ({
        path: `work/acme/VALUE_${i}`,
        value: text(8 + random(32)),
      })),
    ];
    const data = Buffer.from(
      long +
        text(32) +
        unit.repeat(256 + random(128)) +
        long +
        text(32) +
        short +
        long.slice(0, 1 + random(long.length - 1)),
    );
    const stream = masker(maskedValues(entries));
    const split = 1 + random(7);
    const output = [stream.push(data.subarray(0, split))];
    expect(stream.pendingBytes).toBe(split);
    const chunkLimit = sample % 3 === 1 ? 3 : 97;
    for (let at = split; at < data.length; ) {
      const end = Math.min(
        data.length,
        at + (sample % 3 ? 1 + random(chunkLimit) : data.length),
      );
      output.push(stream.push(data.subarray(at, end)));
      at = end;
    }
    output.push(stream.end());
    expect(
      Buffer.concat(output).equals(referenceMask(data, entries)),
      `sample ${sample}`,
    ).toBe(true);
  }
});
it('single-byte writes advance long shared prefixes within a linear tail budget', () => {
  const data = Buffer.alloc(2_048, 'a');
  const entries = Array.from({ length: 20 }, (_, i) => ({
    path: `work/acme/VALUE_${i}`,
    value: data.toString() + String.fromCharCode(66 + i),
  }));
  const expected = referenceMask(data, entries);
  const budget = 4 * entries.length * data.length;
  let work = 0;
  function counted<T extends Uint8Array | Uint32Array>(array: T): T {
    return new Proxy(array, {
      get(target, key) {
        // Successful KMP steps read bytes, but need no failure-link reads.
        if (typeof key === 'string' && /^\d+$/.test(key) && ++work > budget)
          throw new Error('Small writes exceeded the linear tail budget.');
        return Reflect.get(target, key, target);
      },
    });
  }
  const originals = new Map<Uint8Array, Buffer>();
  const values = maskedValues(entries).map((value) => {
    const bytes = counted(value.bytes);
    originals.set(bytes, value.bytes);
    return { ...value, bytes, prefixes: counted(value.prefixes) };
  });
  const stream = masker(values);
  const indexOf = Buffer.prototype.indexOf;
  // Native indexOf requires a real typed array, so unwrap only its needles.
  const search = vi
    .spyOn(Buffer.prototype, 'indexOf')
    .mockImplementation(function (this: Buffer, needle, ...args) {
      if (needle instanceof Uint8Array)
        needle = originals.get(needle) ?? needle;
      return indexOf.call(this, needle, ...args);
    });
  const output: Uint8Array[] = [];
  try {
    for (let at = 0; at < data.length; at++)
      output.push(stream.push(data.subarray(at, at + 1)));
    output.push(stream.end());
  } finally {
    search.mockRestore();
  }
  expect(work).toBeGreaterThanOrEqual(entries.length * data.length);
  expect(Buffer.concat(output).equals(expected)).toBe(true);
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
