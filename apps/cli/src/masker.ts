type MaskedValue = {
  readonly bytes: Buffer;
  readonly marker: Buffer;
  readonly prefixes: Uint32Array;
};
type Value = { readonly path: string; readonly value: string };
type PendingPrefix = { length: number; readonly value: MaskedValue };
type MatchCandidate = {
  at: number;
  searches: number;
  scan?: { pos: number; length: number };
  readonly value: MaskedValue;
};

function extendPrefix(
  bytes: Buffer,
  prefixes: Uint32Array,
  length: number,
  byte: number,
) {
  while (length && bytes[length] !== byte) length = prefixes[length - 1];
  return bytes[length] === byte ? length + 1 : 0;
}
function prefixTable(bytes: Buffer) {
  const prefixes = new Uint32Array(bytes.length);
  for (let i = 1; i < bytes.length; i++)
    prefixes[i] = extendPrefix(bytes, prefixes, prefixes[i - 1], bytes[i]);
  return prefixes;
}
export function maskedValues(values: readonly Value[]): MaskedValue[] {
  const distinct = new Map<string, MaskedValue>();
  for (const { path, value } of [...values].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    if ([...value].length < 8 || distinct.has(value)) continue;
    const bytes = Buffer.from(value);
    distinct.set(value, {
      bytes,
      marker: Buffer.from(`<nook:${path}>`),
      prefixes: prefixTable(bytes),
    });
  }
  return [...distinct.values()].sort((a, b) => b.bytes.length - a.bytes.length);
}
function searchAfter(data: Buffer, candidate: MatchCandidate, from: number) {
  const { bytes, prefixes } = candidate.value;
  // Overlapping replacements can repeatedly invalidate a long cached match.
  // Cap indexOf at 16 searches, then use a forward-only KMP scan for this call.
  if (candidate.searches < 16) {
    candidate.searches++;
    return data.indexOf(bytes, from);
  }
  // After a full match, the automaton resumes at that match's failure link.
  candidate.scan ??= {
    pos: candidate.at + bytes.length,
    length: prefixes[bytes.length - 1],
  };
  const scan = candidate.scan;
  while (scan.pos < data.length) {
    scan.length = extendPrefix(bytes, prefixes, scan.length, data[scan.pos++]);
    if (scan.length === bytes.length) {
      const start = scan.pos - bytes.length;
      scan.length = prefixes[scan.length - 1];
      if (start >= from) return start;
    }
  }
  return -1;
}
function nextMatch(
  data: Buffer,
  candidates: readonly MatchCandidate[],
  from: number,
) {
  let match: MatchCandidate | undefined;
  for (const candidate of candidates) {
    // Keep misses and future matches. Only consumed or overlapping matches
    // need another search in this chunk.
    if (candidate.at !== -1 && candidate.at < from)
      candidate.at = searchAfter(data, candidate, from);
    if (candidate.at !== -1 && (!match || candidate.at < match.at))
      match = candidate;
  }
  return match;
}
function advanceTail(chunk: Uint8Array, tail: PendingPrefix) {
  const { bytes, prefixes } = tail.value;
  // A held prefix is shorter than its value, so a chunk at least that long
  // decides the tail alone: scan only its end, never every byte of the chunk.
  const window = bytes.length - 1;
  const fresh = chunk.length >= window;
  let length = fresh ? 0 : tail.length;
  for (const byte of fresh ? chunk.subarray(chunk.length - window) : chunk) {
    length = extendPrefix(bytes, prefixes, length, byte);
    // Only a proper prefix can need more bytes, even after a full match.
    if (length === bytes.length) length = prefixes[length - 1];
  }
  tail.length = length;
}
function pendingStart(
  data: Buffer,
  tails: readonly PendingPrefix[],
  from: number,
) {
  let start = data.length;
  for (const tail of tails) {
    // A replacement can consume part of a candidate prefix. Reuse its failure
    // links to retain the longest prefix within the unconsumed suffix. These
    // constrained lengths are also the starting states for the next push.
    while (tail.length > data.length - from)
      tail.length = tail.value.prefixes[tail.length - 1];
    start = Math.min(start, data.length - tail.length);
  }
  return start;
}
function replace(
  data: Buffer,
  values: readonly MaskedValue[],
  tails: readonly PendingPrefix[],
  final: boolean,
) {
  const output: Buffer[] = [];
  const candidates = values.map((value) => ({
    at: data.indexOf(value.bytes),
    searches: 1,
    value,
  }));
  let from = 0;
  while (from < data.length) {
    const match = nextMatch(data, candidates, from);
    const pending = final ? data.length : pendingStart(data, tails, from);
    if (!match || match.at >= pending) {
      output.push(data.subarray(from, pending));
      return { output: Buffer.concat(output), held: data.subarray(pending) };
    }
    output.push(data.subarray(from, match.at), match.value.marker);
    from = match.at + match.value.bytes.length;
  }
  for (const tail of tails) tail.length = 0;
  return { output: Buffer.concat(output), held: Buffer.alloc(0) };
}
export function masker(values: readonly MaskedValue[]) {
  let held: Buffer = Buffer.alloc(0);
  const tails = values.map((value) => ({ length: 0, value }));
  return {
    get pendingBytes(): number {
      return held.length;
    },
    push(chunk: Uint8Array): Uint8Array {
      // The held bytes have already advanced each tail's automaton.
      for (const tail of tails) advanceTail(chunk, tail);
      const result = replace(
        Buffer.concat([held, chunk]),
        values,
        tails,
        false,
      );
      held = result.held;
      return result.output;
    },
    end(): Uint8Array {
      const result = replace(held, values, tails, true);
      held = Buffer.alloc(0);
      for (const tail of tails) tail.length = 0;
      return result.output;
    },
  };
}
