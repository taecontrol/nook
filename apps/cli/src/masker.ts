type MaskedValue = { readonly bytes: Buffer; readonly marker: Buffer };
type Value = { readonly path: string; readonly value: string };

export function maskedValues(values: readonly Value[]): MaskedValue[] {
  const distinct = new Map<string, MaskedValue>();
  for (const { path, value } of [...values].sort((a, b) =>
    a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  )) {
    if ([...value].length < 8 || distinct.has(value)) continue;
    distinct.set(value, {
      bytes: Buffer.from(value),
      marker: Buffer.from(`<nook:${path}>`),
    });
  }
  return [...distinct.values()].sort((a, b) => b.bytes.length - a.bytes.length);
}
function nextMatch(data: Buffer, values: readonly MaskedValue[], from: number) {
  let match: { at: number; value: MaskedValue } | undefined;
  for (const value of values) {
    const at = data.indexOf(value.bytes, from);
    if (at !== -1 && (!match || at < match.at)) match = { at, value };
  }
  return match;
}
function prefixStart(data: Buffer, bytes: Buffer, from: number) {
  let at = data.indexOf(
    bytes[0],
    Math.max(from, data.length - bytes.length + 1),
  );
  while (at !== -1) {
    if (bytes.subarray(0, data.length - at).equals(data.subarray(at)))
      return at;
    at = data.indexOf(bytes[0], at + 1);
  }
  return data.length;
}
function pendingStart(
  data: Buffer,
  values: readonly MaskedValue[],
  from: number,
) {
  let start = data.length;
  for (const { bytes } of values)
    start = Math.min(start, prefixStart(data, bytes, from));
  return start;
}
function replace(data: Buffer, values: readonly MaskedValue[], final: boolean) {
  const output: Buffer[] = [];
  let from = 0;
  while (from < data.length) {
    const match = nextMatch(data, values, from);
    const pending = final ? data.length : pendingStart(data, values, from);
    if (!match || match.at >= pending) {
      output.push(data.subarray(from, pending));
      return { output: Buffer.concat(output), held: data.subarray(pending) };
    }
    output.push(data.subarray(from, match.at), match.value.marker);
    from = match.at + match.value.bytes.length;
  }
  return { output: Buffer.concat(output), held: Buffer.alloc(0) };
}
export function masker(values: readonly MaskedValue[]) {
  let held: Buffer = Buffer.alloc(0);
  return {
    push(chunk: Uint8Array): Uint8Array {
      const result = replace(Buffer.concat([held, chunk]), values, false);
      held = result.held;
      return result.output;
    },
    end(): Uint8Array {
      const result = replace(held, values, true);
      held = Buffer.alloc(0);
      return result.output;
    },
  };
}
