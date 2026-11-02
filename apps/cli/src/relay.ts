import { closeSync, read, write, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { splitFlushToken } from './flush-token.ts';
import { maskedValues, masker } from './masker.ts';

function failure() {
  // Avoid platform errors: their text can include arbitrary output bytes.
  try {
    writeSync(2, 'Nook output masking failed.\n');
  } catch {
    /* The reader may have closed stderr too. */
  }
}
function writeSome(target: number, chunk: Uint8Array, offset: number) {
  return new Promise<number>((accept, reject) => {
    write(target, chunk, offset, chunk.length - offset, null, (error, size) => {
      if (error) reject(error);
      else if (!size) reject(new Error('Output write made no progress.'));
      else accept(size);
    });
  });
}
function forwarder(
  fd: number,
  target: number,
  values: ReturnType<typeof maskedValues>,
  token: Buffer,
) {
  let reader: number | undefined = fd;
  let reading = false;
  let stopped = false;
  let markFlushed: () => void;
  const flushed = new Promise<void>((accept) => {
    markFlushed = accept;
  });
  const masking = masker(values);
  const splitter = splitFlushToken(token);
  const closeInput = () => {
    // A blocked fs.read cannot be cancelled. Its callback closes the fd if
    // stop arrived during that read, without starting another read or write.
    if (reader !== undefined && !reading) {
      closeSync(reader);
      reader = undefined;
    }
  };
  const stop = () => {
    stopped = true;
    closeInput();
    markFlushed();
  };
  async function written(chunk: Uint8Array) {
    let offset = 0;
    let backoff = 1;
    while (!stopped && offset < chunk.length) {
      try {
        offset += await writeSome(target, chunk, offset);
        backoff = 1;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
        // The caller can share a nonblocking destination. This timer only
        // paces write retries; it never decides masking or the flush boundary.
        await new Promise((accept) => setTimeout(accept, backoff));
        backoff = Math.min(backoff * 2, 50);
      }
    }
  }
  function readBlocking(bytes: Buffer) {
    return new Promise<number>((accept, reject) => {
      reading = true;
      read(fd, bytes, 0, bytes.length, null, (error, size) => {
        reading = false;
        if (stopped) {
          closeInput();
          accept(0);
        } else if (error) reject(error);
        else accept(size);
      });
    });
  }
  async function forward(chunk: Uint8Array) {
    const { before, after } = splitter.push(chunk);
    await written(
      masking.push(
        after === undefined ? before : Buffer.concat([before, after]),
      ),
    );
    if (after !== undefined) {
      // Remove the token transparently: a value can span it. Flush a tail
      // only if it began before the token. Never read ahead: an idle writer
      // can block forever. A writer paused mid-value here whose rest is not
      // in this read is the accepted best-effort gap at the flush boundary.
      if (masking.pendingBytes > after.length) await written(masking.end());
      markFlushed();
    }
  }
  async function followWriters() {
    const bytes = Buffer.alloc(64 * 1024);
    try {
      // One blocking read per FIFO, from the start: kqueue cannot reliably
      // signal either data from a blocked large FIFO write or FIFO EOF.
      // Each fs.write finishes before the next read, so EPIPE closes the
      // reader immediately. No output fd uses kqueue, including named FIFOs.
      // At most two operations occupy libuv's four pool threads.
      while (!stopped) {
        const size = await readBlocking(bytes);
        if (stopped) return;
        if (size === 0) break;
        await forward(bytes.subarray(0, size));
      }
      await written(masking.push(splitter.end()));
      await written(masking.end());
      closeInput();
      markFlushed();
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EPIPE') failure();
      stop();
    } finally {
      // Close only this copy; never shutdown the caller's shared socket.
      closeSync(target);
    }
  }
  void followWriters();
  return { stop, flushed };
}
export async function relayMain() {
  const control = new Socket({ fd: 3, readable: true, writable: true });
  const lines = createInterface({ input: control });
  const streams: ReturnType<typeof forwarder>[] = [];
  control.on('error', () => {});
  try {
    const targets = JSON.parse(process.argv.at(-1) ?? '[]') as number[];
    control.write('ready\n');
    for await (const line of lines) {
      const message = JSON.parse(line) as {
        values: { path: string; value: string }[];
        token: string;
      };
      const values = maskedValues(message.values);
      const token = Buffer.from(message.token);
      targets.forEach((target, index) => {
        streams.push(forwarder(index + 4, target, values, token));
      });
      control.write('values\n');
      void Promise.all(streams.map((stream) => stream.flushed)).then(() => {
        if (!control.destroyed) control.write('flushed\n');
      });
    }
    // Lost control sends no implicit flush: blocking reads keep masking until
    // all writers close, and EOF releases the remaining token/value prefixes.
  } catch {
    failure();
    for (const stream of streams) stream.stop();
  } finally {
    control.destroy();
  }
}
