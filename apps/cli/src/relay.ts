import { createWriteStream, readSync, writeSync } from 'node:fs';
import { Socket } from 'node:net';
import { createInterface } from 'node:readline';
import { maskedValues, masker } from './masker.ts';

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
) {
  const input = new Socket({ fd, readable: true, writable: false });
  const output = createWriteStream('', { fd: target, autoClose: false });
  const masking = masker(values);
  let stopped = false;
  const stop = () => {
    stopped = true;
    input.destroy();
    output.destroy();
  };
  const write = (chunk: Uint8Array) => {
    if (!stopped && chunk.length && !output.write(chunk)) input.pause();
  };
  input.on('data', (chunk: Buffer) => write(masking.push(chunk)));
  output.on('drain', () => input.resume());
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
  function drain() {
    const bytes = Buffer.alloc(64 * 1024);
    while (!stopped) {
      let size: number;
      try {
        size = readSync(fd, bytes, 0, bytes.length, null);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EAGAIN') return;
        throw error;
      }
      if (!size) return;
      write(masking.push(bytes.subarray(0, size)));
    }
  }
  return {
    stop,
    async flush() {
      if (stopped) return;
      input.pause();
      // read() emits data synchronously, including buffered bytes after pause().
      while (input.read() !== null) {}
      if (!input.destroyed) drain();
      await new Promise<void>((accept) => {
        output.once('error', accept);
        const complete = () => {
          output.off('error', accept);
          accept();
        };
        if (output.writableEnded) output.once('finish', complete);
        else output.write(masking.end(), complete);
      });
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
    control.write('ready\n');
    for await (const line of lines) {
      const message = JSON.parse(line) as {
        type: string;
        values: { path: string; value: string }[];
      };
      if (message.type === 'values') {
        const values = maskedValues(message.values);
        targets.forEach((target, index) => {
          streams.push(forwarder(index + 4, target, values));
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
