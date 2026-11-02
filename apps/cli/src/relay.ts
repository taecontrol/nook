import { execFileSync } from 'node:child_process';
import {
  closeSync,
  createReadStream,
  createWriteStream,
  fstatSync,
  type ReadStream,
  readFileSync,
  readSync,
  writeSync,
} from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { maskedValues, masker } from './masker.ts';

function fifoCapacityBound() {
  // Node exposes neither F_GETPIPE_SZ nor FIONREAD. Use the OS's allocation
  // ceiling, not the default capacity: Linux FIFOs can grow, and macOS FIFOs
  // use local sockets (fifo_vnops.c), not BIG_PIPE_SIZE anonymous pipes.
  const limit = Number(
    process.platform === 'linux'
      ? readFileSync('/proc/sys/fs/pipe-max-size', 'utf8')
      : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.ipc.maxsockbuf'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }),
  );
  if (!Number.isSafeInteger(limit) || limit <= 0)
    throw new Error('Cannot determine the FIFO capacity bound.');
  return limit;
}
function readAvailable(fd: number, bytes: Buffer, length: number) {
  try {
    return readSync(fd, bytes, 0, length, null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return undefined;
    throw error;
  }
}
function failure() {
  // Avoid platform errors: their text can include arbitrary output bytes.
  try {
    writeSync(2, 'Nook output masking failed.\n');
  } catch {
    /* The reader may have closed stderr too. */
  }
}
function forwarder(
  fd: number,
  blockingFd: number,
  target: number,
  values: ReturnType<typeof maskedValues>,
  capacity: number,
) {
  const socket = new Socket({ fd, readable: true, writable: false });
  let input: Socket | ReadStream = socket;
  let idleReader: number | undefined = blockingFd;
  const output = createWriteStream('', { fd: target, autoClose: false });
  const masking = masker(values);
  // Also cover Linux's initial 16-page capacity if its sysctl was lowered.
  const bound = Math.max(capacity, 16 * fstatSync(fd).blksize);
  let stopped = false;
  let flushing = false;
  const closeInputs = () => {
    input.destroy();
    if (idleReader !== undefined) closeSync(idleReader);
    idleReader = undefined;
  };
  const stop = () => {
    stopped = true;
    closeInputs();
    output.destroy();
  };
  const write = (chunk: Uint8Array) => {
    if (!stopped && chunk.length && !output.write(chunk)) input.pause();
  };
  const end = () => {
    if (stopped || output.writableEnded) return;
    write(masking.end());
    output.end();
    closeInputs();
  };
  const forward = () => {
    input.on('data', (chunk: Buffer) => write(masking.push(chunk)));
    input.on('error', () => {
      failure();
      stop();
    });
    input.on('end', end);
  };
  forward();
  output.on('drain', () => {
    if (!flushing && !stopped) input.resume();
  });
  output.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') failure();
    stop();
  });
  output.on('finish', () => {
    stopped = true;
  });
  function written(chunk: Uint8Array) {
    return new Promise<void>((accept) => {
      if (stopped || output.writableFinished) return accept();
      const complete = () => {
        output.off('error', complete);
        output.off('finish', complete);
        accept();
      };
      output.once('error', complete);
      if (output.writableEnded) output.once('finish', complete);
      else output.write(chunk, complete);
    });
  }
  async function drainChunk(bytes: Buffer, length: number) {
    if (socket.readableLength) {
      // read() emits data synchronously through the normal masking handler.
      // libuv may have buffered more bytes while a previous write completed;
      // consume those before reading the fd directly to preserve byte order.
      const chunk = socket.read(
        Math.min(socket.readableLength, length),
      ) as Buffer;
      await written(Buffer.alloc(0));
      return chunk.length;
    }
    if (socket.destroyed) return 0;
    const size = readAvailable(fd, bytes, length);
    // Wait for each write, including backpressure, before taking more data.
    if (size) await written(masking.push(bytes.subarray(0, size)));
    return size;
  }
  async function drain(remaining: number) {
    const bytes = Buffer.alloc(64 * 1024);
    const longest = values[0]?.bytes.length ?? 0;
    // A held tail starts before the boundary while it exceeds the bytes read
    // past it. At most one longest value of lookahead resolves those bytes.
    while (!stopped && remaining + masking.pendingBytes > 0) {
      const length = remaining > 0 ? remaining : longest + remaining;
      const size = await drainChunk(bytes, Math.min(bytes.length, length));
      if (size === 0) {
        // read(2) sees FIFO EOF even when macOS kqueue never ends the Socket.
        end();
        await written(Buffer.alloc(0));
        return;
      }
      if (size === undefined) {
        // EAGAIN confirms the flush. A background writer pausing mid-value
        // exactly here is the accepted best-effort gap: release its held tail.
        await written(masking.end());
        return;
      }
      remaining -= size;
    }
  }
  function followWriters() {
    // Preserve any bytes libuv buffered during the flush's awaited writes.
    // read() emits them through the same masker before the reader changes.
    if (socket.readableLength) socket.read();
    socket.destroy();
    // A pending blocking read occupies one threadpool thread per FIFO (two at
    // most). It starts only after flush; ReadStream observes EOF on macOS too.
    input = createReadStream('', { fd: blockingFd });
    idleReader = undefined;
    forward();
    if (output.writableNeedDrain) input.pause();
  }
  return {
    stop,
    async flush() {
      if (stopped || output.writableEnded || input !== socket) {
        await written(Buffer.alloc(0));
        return;
      }
      flushing = true;
      socket.pause();
      // The child has exited: its unwritten bytes fit in the JS buffer plus
      // one FIFO capacity. Later writers cannot extend this finite boundary.
      const remaining = socket.readableLength + bound;
      await written(Buffer.alloc(0));
      await drain(remaining);
      if (!stopped && !output.writableEnded) followWriters();
      flushing = false;
    },
  };
}
export async function relayMain() {
  const control = new Socket({ fd: 3, readable: true, writable: true });
  const lines = createInterface({ input: control });
  const streams: ReturnType<typeof forwarder>[] = [];
  control.on('error', () => {});
  try {
    const targets = JSON.parse(process.argv.at(-1) ?? '[]') as number[];
    const capacity = fifoCapacityBound();
    control.write('ready\n');
    for await (const line of lines) {
      const message = JSON.parse(line) as {
        type: string;
        values: { path: string; value: string }[];
      };
      if (message.type === 'values') {
        const values = maskedValues(message.values);
        targets.forEach((target, index) => {
          streams.push(
            forwarder(
              index + 4,
              index + 4 + targets.length,
              target,
              values,
              capacity,
            ),
          );
        });
        control.write('values\n');
      } else if (message.type === 'flush') {
        await Promise.all(streams.map((stream) => stream.flush()));
        control.write('flushed\n');
      }
    }
  } catch {
    failure();
    for (const stream of streams) stream.stop();
  } finally {
    control.destroy();
  }
}
