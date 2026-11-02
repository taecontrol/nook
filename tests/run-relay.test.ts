import { Duplex, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { relayMain } from '../apps/cli/src/relay.ts';

const io = vi.hoisted(() => ({
  chunks: [] as Buffer[],
  output: [] as Buffer[],
  atFlush: Buffer.alloc(0),
  control: undefined as Duplex | undefined,
  closed: () => {},
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  fstatSync: () => ({ isFIFO: () => false, isSocket: () => false }),
  closeSync: () => io.closed(),
  read: (
    _fd: number,
    bytes: Buffer,
    _at: number,
    _size: number,
    _pos: null,
    done: (error: null, size: number) => void,
  ) => {
    const chunk = io.chunks.shift() ?? Buffer.alloc(0);
    chunk.copy(bytes);
    queueMicrotask(() => done(null, chunk.length));
  },
  write: (
    _fd: number,
    bytes: Buffer,
    at: number,
    size: number,
    _pos: null,
    done: (error: null, size: number) => void,
  ) => {
    io.output.push(Buffer.from(bytes.subarray(at, at + size)));
    queueMicrotask(() => done(null, size));
  },
  createWriteStream: () =>
    new Writable({
      write(bytes, _encoding, done) {
        io.output.push(Buffer.from(bytes));
        done();
      },
    }),
}));
vi.mock('node:net', () => ({
  Socket: class {
    constructor() {
      return io.control;
    }
  },
}));

const path = 'work/acme/TOKEN';
const value = 'abcdefgh12345678';
const marker = `<nook:${path}>`;
const token = `\0nook-flush:${'0123456789abcdef'.repeat(4)}\0`;
async function forward(chunks: string[]) {
  io.chunks = chunks.map((chunk) => Buffer.from(chunk));
  io.output = [];
  const closed = new Promise<void>((accept) => {
    io.closed = accept;
  });
  io.control = new Duplex({
    read() {},
    write(bytes, _encoding, done) {
      if (String(bytes) === 'ready\n')
        this.push(JSON.stringify({ values: [{ path, value }], token }) + '\n');
      if (String(bytes) === 'flushed\n') {
        io.atFlush = Buffer.concat(io.output);
        this.push(null);
      }
      done();
    },
  });
  const previous = process.argv;
  process.argv = ['node', 'relay', '[1]'];
  try {
    await relayMain();
    await closed;
    return Buffer.concat(io.output);
  } finally {
    process.argv = previous;
  }
}
it.each([
  [value.slice(0, 8) + token + value.slice(8)],
  [value.slice(0, 4), value.slice(4, 8) + token + value.slice(8)],
  [value.slice(0, 8) + token.slice(0, 20), token.slice(20) + value.slice(8)],
])(
  'a token inside a value preserves continuous masking across chunks (%j)',
  async (...chunks) => {
    const output = await forward(chunks);
    expect(output.includes(value)).toBe(false);
    expect(output.includes(token)).toBe(false);
    expect(output.toString()).toBe(marker);
    expect(io.atFlush.toString()).toBe(marker);
  },
);
it('a value prefix entirely after the token stays held for the next read', async () => {
  const output = await forward([
    'before' + token + value.slice(0, 8),
    value.slice(8),
  ]);
  expect(io.atFlush.toString()).toBe('before');
  expect(output.toString()).toBe('before' + marker);
});
it('a held prefix beginning before the token is flushed without another read', async () => {
  const output = await forward([value.slice(0, 4) + token + value.slice(4, 8)]);
  expect(io.atFlush.toString()).toBe(value.slice(0, 8));
  expect(output.toString()).toBe(value.slice(0, 8));
});
