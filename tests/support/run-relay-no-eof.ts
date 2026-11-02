import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type SocketConstructorOpts } from 'node:net';
import { MessageChannel } from 'node:worker_threads';

// Model macOS kqueue's missing FIFO EOF without changing real bytes, fd reads,
// writes or backpressure. The control Socket is not a FIFO and stays intact.
net.Socket = class extends net.Socket {
  readonly suppressEof: boolean;

  constructor(options: SocketConstructorOpts = {}) {
    super(options);
    this.suppressEof =
      options.readable !== false &&
      options.fd !== undefined &&
      fstatSync(options.fd).isFIFO();
    if (this.suppressEof) {
      // Linux stops polling at EOF even when push(null) is swallowed. Keep the
      // reader alive until explicit close, as a still-polled kqueue FIFO is.
      const { port1, port2 } = new MessageChannel();
      port1.on('message', () => {});
      this.once('close', () => {
        port1.close();
        port2.close();
      });
    }
  }

  override push(chunk: unknown, encoding?: BufferEncoding) {
    if (chunk === null && this.suppressEof) return false;
    return super.push(chunk, encoding);
  }
};
syncBuiltinESMExports();
