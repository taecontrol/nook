import 'node:assert/strict';
import { fstatSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import net, { type SocketConstructorOpts } from 'node:net';

// Prime Node's lazy assertion/color stdio before guarding relay constructors;
// those runtime-owned handles do not forward the relay's data.
// Only control fd 3 may use a Socket. FIFO reads and all output writes must
// stay off kqueue; real fs I/O, backpressure and EOF remain untouched.
net.Socket = class extends net.Socket {
  constructor(options: SocketConstructorOpts = {}) {
    if (
      options.fd !== undefined &&
      ([1, 2].includes(options.fd) ||
        (options.fd >= 4 && fstatSync(options.fd).isFIFO()))
    )
      throw new Error('Relay data I/O must use fs.read and fs.write.');
    super(options);
  }
};
syncBuiltinESMExports();
