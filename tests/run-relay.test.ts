import { Duplex, Writable } from 'node:stream';
import { expect, it, vi } from 'vitest';
import { relayMain } from '../apps/cli/src/relay.ts';

const io = vi.hoisted(() => ({
  chunks: [] as Buffer[],
  output: [] as Buffer[],
  diagnostics: [] as string[],
  results: [] as (number | string)[],
  reads: 0,
  writing: false,
  overlappingIO: false,
  closedFds: [] as number[],
  atFlush: Buffer.alloc(0),
  control: undefined as Duplex | undefined,
  closed: () => {},
}));
vi.mock('node:fs', async (original) => ({
  ...(await original<typeof import('node:fs')>()),
  // Retain the previous stream seam so the token regression also runs
  // against that relay and fails on leaked bytes, rather than test setup.
  fstatSync: () => ({ isFIFO: () => false, isSocket: () => false }),
  createWriteStream: () =>
    new Writable({
      write(bytes, _encoding, done) {
        io.output.push(Buffer.from(bytes));
        done();
      },
    }),
  closeSync: (fd: number) => {
    io.closedFds.push(fd);
    io.closed();
  },
  writeSync: (_fd: number, text: string) => {
    io.diagnostics.push(text);
  },
  read: (
    _fd: number,
    bytes: Buffer,
    _at: number,
    _size: number,
    _pos: null,
    done: (error: null, size: number) => void,
  ) => {
    io.reads++;
    io.overlappingIO ||= io.writing;
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
    done: (error: NodeJS.ErrnoException | null, size: number) => void,
  ) => {
    io.overlappingIO ||= io.writing;
    io.writing = true;
    const result = io.results.shift() ?? size;
    const written = typeof result === 'number' ? Math.min(size, result) : 0;
    io.output.push(Buffer.from(bytes.subarray(at, at + written)));
    queueMicrotask(() => {
      io.writing = false;
      done(
        typeof result === 'string'
          ? Object.assign(new Error('private output bytes'), { code: result })
          : null,
        written,
      );
    });
  },
}));
vi.mock('node:net', () => ({
  Socket: vi.fn(function controlSocket() {
    return io.control;
  }),
}));

const path = 'work/acme/TOKEN';
const value = 'abcdefgh12345678';
const marker = `<nook:${path}>`;
const token = `\0nook-flush:${'0123456789abcdef'.repeat(4)}\0`;
async function forward(chunks: string[], results: (number | string)[] = []) {
  io.chunks = chunks.map((chunk) => Buffer.from(chunk));
  io.output = [];
  io.diagnostics = [];
  io.results = results;
  io.reads = 0;
  io.writing = false;
  io.overlappingIO = false;
  io.closedFds = [];
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
it('partial writes and EAGAIN retries finish each chunk before reading again or acknowledging flush', async () => {
  const output = await forward([value + token], [1, 'EAGAIN', 2, 'EAGAIN', 3]);
  expect(output.toString()).toBe(marker);
  expect(io.atFlush.toString()).toBe(marker);
  expect(io.overlappingIO).toBe(false);
  expect(io.reads).toBe(2);
  expect(io.diagnostics).toEqual([]);
});
it.each(['EPIPE', 'EIO', 0])(
  'output failure %s stops reads and closes the FIFO with only a fixed diagnostic',
  async (result) => {
    await forward([value, 'never read'], [result]);
    expect(io.reads).toBe(1);
    expect(io.closedFds).toEqual([4, 1]);
    expect(io.diagnostics).toEqual(
      result === 'EPIPE' ? [] : ['Nook output masking failed.\n'],
    );
  },
);
it('a held prefix beginning before the token is flushed without another read', async () => {
  const output = await forward([value.slice(0, 4) + token + value.slice(4, 8)]);
  expect(io.atFlush.toString()).toBe(value.slice(0, 8));
  expect(output.toString()).toBe(value.slice(0, 8));
});
