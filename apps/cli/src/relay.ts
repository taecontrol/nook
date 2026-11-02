import { execFileSync } from 'node:child_process';
import {
  createWriteStream,
  fstatSync,
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
    if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return 0;
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
  target: number,
  values: ReturnType<typeof maskedValues>,
  capacity: number,
) {
  const input = new Socket({ fd, readable: true, writable: false });
  const output = createWriteStream('', { fd: target, autoClose: false });
  const masking = masker(values);
  // Also cover Linux's initial 16-page capacity if its sysctl was lowered.
  const bound = Math.max(capacity, 16 * fstatSync(fd).blksize);
  let stopped = false;
  let flushing = false;
  const stop = () => {
    stopped = true;
    input.destroy();
    output.destroy();
  };
  const write = (chunk: Uint8Array) => {
    if (!stopped && chunk.length && !output.write(chunk)) input.pause();
  };
  input.on('data', (chunk: Buffer) => write(masking.push(chunk)));
  output.on('drain', () => {
    if (!flushing && !stopped) input.resume();
  });
  output.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') failure();
    stop();
  });
  input.on('error', () => {
    failure();
    stop();
  });
  input.on('end', () => {
    write(masking.end());
    output.end();
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
  async function drain(remaining: number) {
    const bytes = Buffer.alloc(64 * 1024);
    while (!stopped && remaining > 0) {
      if (input.readableLength) {
        // read() emits data synchronously through the normal masking handler.
        // libuv may have buffered more bytes while a previous write completed;
        // consume those before reading the fd directly to preserve byte order.
        const chunk = input.read(
          Math.min(input.readableLength, remaining),
        ) as Buffer;
        remaining -= chunk.length;
        await written(Buffer.alloc(0));
      } else {
        if (input.destroyed) return;
        const size = readAvailable(
          fd,
          bytes,
          Math.min(bytes.length, remaining),
        );
        if (!size) return;
        remaining -= size;
        // Wait for each write, including backpressure, before taking more data.
        await written(masking.push(bytes.subarray(0, size)));
      }
    }
  }
  return {
    stop,
    async flush() {
      if (stopped) return;
      flushing = true;
      input.pause();
      // The child has exited: its unwritten bytes fit in the JS buffer plus
      // one FIFO capacity. Later writers cannot extend this finite boundary.
      const remaining = input.readableLength + bound;
      await written(Buffer.alloc(0));
      await drain(remaining);
      await written(masking.end());
      flushing = false;
      if (!stopped) input.resume();
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
          streams.push(forwarder(index + 4, target, values, capacity));
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
