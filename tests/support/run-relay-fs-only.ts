import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type SocketConstructorOpts } from 'node:net';

// Fail before any kqueue-backed FIFO reader can start. Control fd 3 remains a
// real socket; fs.read, output writes, backpressure and EOF remain untouched.
net.Socket = class extends net.Socket {
  constructor(options: SocketConstructorOpts = {}) {
    if (
      options.readable !== false &&
      options.fd !== undefined &&
      options.fd >= 4 &&
      fstatSync(options.fd).isFIFO()
    )
      throw new Error('FIFO readers must use fs.read.');
    super(options);
  }
};
syncBuiltinESMExports();
