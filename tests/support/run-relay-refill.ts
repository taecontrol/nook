import { execFileSync } from 'node:child_process';
import fs, {
  closeSync,
  openSync,
  readFileSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { Socket } from 'node:net';
import { resolve } from 'node:path';

// Refill the real FIFO after each synchronous drain read, so even a fast relay
// cannot escape the old unbounded loop through a scheduling-dependent EAGAIN.
const home = new URL(import.meta.url).searchParams.get('home');
if (!home) throw new Error('The refill fixture requires a private HOME.');
const requests = openSync(resolve(home, 'refill-requests'), 'r+');
const replies = openSync(resolve(home, 'refill-replies'), 'r+');
const read = fs.readSync;
const { maximumTailBytes } = JSON.parse(
  readFileSync(resolve(home, 'continuous-output'), 'utf8'),
) as { maximumTailBytes: number };
const maximum = Number(
  process.platform === 'linux'
    ? readFileSync('/proc/sys/fs/pipe-max-size', 'utf8')
    : execFileSync('/usr/sbin/sysctl', ['-n', 'kern.ipc.maxsockbuf'], {
        encoding: 'utf8',
      }),
);
let transferred = 0;
let active = true;
function request(size: number) {
  const header = Buffer.alloc(4);
  header.writeUInt32BE(size);
  writeSync(requests, header);
  read(replies, Buffer.alloc(1), 0, 1, null);
}
fs.readSync = ((
  fd: number,
  bytes: Buffer,
  offset: number,
  length: number,
  position: null,
) => {
  if (fd !== 4 || !active) return read(fd, bytes, offset, length, position);
  let size: number;
  try {
    size = read(fd, bytes, offset, length, position);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EAGAIN') throw error;
    request(512);
    size = read(fd, bytes, offset, length, position);
  }
  transferred += size;
  if (transferred > maximum + maximumTailBytes) {
    // The OS byte boundary plus at most one value to resolve a straddling tail,
    // not a timeout or a repetition budget. Let a broken implementation finish
    // so its regression fails by assertion.
    writeFileSync(
      resolve(home, 'flush-overrun'),
      'Drain exceeded FIFO capacity.',
    );
    request(0xffffffff);
    active = false;
  } else if (size) request(size);
  return size;
}) as typeof fs.readSync;
const write = Socket.prototype.write;
Socket.prototype.write = function (
  this: Socket,
  ...args: Parameters<Socket['write']>
) {
  if (args[0] === 'flushed\n' && active) {
    active = false;
    // Switch to an autonomous writer before allowing the CLI to observe flush.
    request(0);
    closeSync(requests);
    closeSync(replies);
  }
  return write.apply(this, args);
} as Socket['write'];
syncBuiltinESMExports();
