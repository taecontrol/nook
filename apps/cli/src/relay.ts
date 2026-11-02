import {
  closeSync,
  createWriteStream,
  fstatSync,
  read,
  writeSync,
} from 'node:fs';
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
function outputStream(target: number) {
  const destination = fstatSync(target);
  // fs.WriteStream retries EAGAIN only five times. Pipes/sockets need libuv's
  // writable readiness under backpressure; this Socket never reads a FIFO.
  return destination.isFIFO() || destination.isSocket()
    ? new Socket({ fd: target, readable: false, writable: true })
    : createWriteStream('', { fd: target, autoClose: false });
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
  const output = outputStream(target);
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
  const stop = (error?: Error) => {
    stopped = true;
    closeInput();
    output.destroy(error);
    markFlushed();
  };
  output.on('error', (error: NodeJS.ErrnoException) => {
    if (error.code !== 'EPIPE') failure();
    stop();
  });
  function written(chunk: Uint8Array) {
    return new Promise<void>((accept) => {
      if (stopped || !chunk.length) return accept();
      output.write(chunk, (error) => {
        if (error) stop(error);
        accept();
      });
    });
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
    await written(masking.push(before));
    if (after !== undefined) {
      await written(masking.end());
      // Confirm only the completed writes before the token. Background output
      // in this same read must not extend the boundary or delay the caller.
      markFlushed();
      await written(masking.push(after));
    }
  }
  async function followWriters() {
    const bytes = Buffer.alloc(64 * 1024);
    try {
      // One blocking read per FIFO, from the start: kqueue cannot reliably
      // signal either data from a blocked large FIFO write or FIFO EOF.
      // Each write finishes before the next read, so EPIPE closes the reader
      // immediately. At most two operations occupy libuv's four pool threads.
      while (!stopped) {
        const size = await readBlocking(bytes);
        if (stopped) return;
        if (size === 0) break;
        await forward(bytes.subarray(0, size));
      }
      await written(masking.push(splitter.end()));
      await written(masking.end());
      // Close only the relay's copy. Socket.end() would shutdown the caller's
      // shared socket too, preventing Nook's own post-flush diagnostics.
      if (output instanceof Socket) output.destroy();
      else output.end();
      closeInput();
      markFlushed();
    } catch {
      failure();
      stop();
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
