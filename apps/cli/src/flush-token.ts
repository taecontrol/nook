// A run inserts one atomic token per FIFO. Strip only its first occurrence;
// later background output passes through unchanged, including token prefixes.
export function splitFlushToken(token: Buffer) {
  let held: Buffer = Buffer.alloc(0);
  let found = false;
  function pendingLength(bytes: Buffer) {
    for (
      let length = Math.min(bytes.length, token.length - 1);
      length;
      length--
    )
      if (
        bytes.subarray(bytes.length - length).equals(token.subarray(0, length))
      )
        return length;
    return 0;
  }
  return {
    push(chunk: Uint8Array): { before: Uint8Array; after?: Uint8Array } {
      if (found) return { before: chunk };
      const bytes = Buffer.concat([held, chunk]);
      const at = bytes.indexOf(token);
      if (at !== -1) {
        held = Buffer.alloc(0);
        found = true;
        return {
          before: bytes.subarray(0, at),
          after: bytes.subarray(at + token.length),
        };
      }
      const end = bytes.length - pendingLength(bytes);
      held = bytes.subarray(end);
      return { before: bytes.subarray(0, end) };
    },
    end(): Uint8Array {
      const tail = held;
      held = Buffer.alloc(0);
      return tail;
    },
  };
}
