import { once } from 'node:events';
import {
  lstat,
  mkdir,
  readdir,
  readFile,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import { deferred } from './support/machines.ts';
import {
  attachFile,
  digest,
  fileMemory,
  maximumFile,
  pdfName,
  seedFileMemory,
} from './support/memory-files.ts';
import {
  configureFilesCli,
  fileTransport,
} from './support/memory-files-cli.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';
import { expectOutput } from './support/private-assertions.ts';

let app: FilesRuntime;
let keyring: PrivateKeyring;
let machine: Awaited<ReturnType<typeof seedFileMemory>>;
let transport: Awaited<ReturnType<typeof fileTransport>> | undefined;
let directory: string;
beforeEach(async () => {
  transport = undefined;
  app = await filesRuntime();
  machine = await seedFileMemory(app);
  keyring = await privateKeyring();
  directory = resolve(keyring.home, 'downloads');
  await mkdir(directory);
});
afterEach(async () => {
  await transport?.close();
  await keyring?.close();
  await app?.close();
});
async function proxy(options: Parameters<typeof fileTransport>[1] = {}) {
  transport = await fileTransport(app, options);
  await configureFilesCli(keyring, transport.origin, machine.token);
  return transport;
}
const startDownload = () =>
  keyring.start(['memory', 'download', fileMemory, pdfName], {}, '', directory);
const changed =
  'The file changed while downloading; nothing was written. Download it again.';
const timedOut =
  'The file transfer timed out after 10 seconds without progress. Try again.';
function failure(
  result: Awaited<ReturnType<typeof startDownload>['done']>,
  message: string,
) {
  expect(result.status).toBe(1);
  expectOutput(result.stdout + result.stderr, message, true);
}
async function temporaryPath() {
  const names = await readdir(directory);
  expect(names).toHaveLength(1);
  expect(names[0]).toMatch(/^\.nook-download-.*\.tmp$/);
  return resolve(directory, names[0]);
}

it('E16: substituting the temporary entry during a held real download cannot publish unverified bytes', async () => {
  await attachFile(app, machine.token, { bytes: Buffer.alloc(4096, 129) });
  const held = deferred();
  const gate = deferred();
  await proxy({
    deliver: async (source, target) => {
      const bytes = Buffer.from(await source.arrayBuffer());
      target.write(bytes.subarray(0, 32));
      held.resolve();
      await gate.promise;
      target.end(bytes.subarray(32));
    },
  });
  const child = startDownload();
  try {
    await held.promise;
    const temporary = await temporaryPath();
    await expect.poll(async () => (await lstat(temporary)).size).toBe(32);
    await unlink(temporary);
    await writeFile(temporary, Buffer.alloc(32, 183), { flag: 'wx' });
    gate.resolve();
    failure(await child.done, changed);
    expect(await readdir(directory)).toEqual([]);
  } finally {
    gate.resolve();
  }
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'a %s interrupts a partial download and awaits temporary-file cleanup',
  async (signal) => {
    await attachFile(app, machine.token, { bytes: Buffer.alloc(4096, 129) });
    const held = deferred();
    await proxy({
      deliver: async (source, target) => {
        target.write(Buffer.from(await source.arrayBuffer()).subarray(0, 32));
        held.resolve();
        await once(target, 'close');
      },
    });
    const child = startDownload();
    await held.promise;
    const temporary = await temporaryPath();
    await expect.poll(async () => (await lstat(temporary)).size).toBe(32);
    expect(await child.kill(signal)).toBe(true);
    expect((await child.done).status).not.toBe(0);
    expect(await readdir(directory)).toEqual([]);
  },
);

it('CLI attach refuses a FIFO without a writer immediately, before any HTTP request', async () => {
  const transport = await proxy();
  const path = resolve(keyring.home, 'source.fifo');
  expect((await keyring.command('/usr/bin/mkfifo', [path]).done).status).toBe(
    0,
  );
  const child = keyring.start(['memory', 'attach', fileMemory, path]);
  let complete = false;
  void child.done.then(() => {
    complete = true;
  });
  try {
    await expect.poll(() => complete, { timeout: 2000 }).toBe(true);
    failure(await child.done, `Could not read ${path}.`);
    expect(transport.requests).toEqual([]);
  } finally {
    if (!complete) await child.kill();
  }
});

it('a real upload progressing for longer than ten seconds succeeds with the Worker digest', async () => {
  const bytes = Buffer.alloc(maximumFile, 129);
  const path = resolve(keyring.home, pdfName);
  await writeFile(path, bytes);
  const progress: number[] = [];
  await proxy({
    receive: async (request) => {
      const chunks: Buffer[] = [];
      for await (const chunk of request) {
        chunks.push(Buffer.from(chunk));
        progress.push(performance.now());
        await delay(500);
      }
      return chunks;
    },
  });
  const started = performance.now();
  const result = await keyring.start(['memory', 'attach', fileMemory, path])
    .done;
  console.info(
    `Idle-timeout upload regression: ${Math.round(performance.now() - started)} ms`,
  );
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout)).toMatchObject({
    size: maximumFile,
    sha256: digest(bytes),
  });
  expect(progress.at(-1)! - progress[0]).toBeGreaterThan(10_000);
  expect(
    Math.max(...progress.slice(1).map((at, index) => at - progress[index])),
  ).toBeLessThan(10_000);
}, 40_000);

it('a real download progressing for longer than ten seconds succeeds with byte-identical output', async () => {
  const bytes = Buffer.alloc(24 * 1024 * 1024, 129);
  await attachFile(app, machine.token, { bytes });
  const progress: number[] = [];
  await proxy({
    deliver: async (source, target) => {
      const bytes = Buffer.from(await source.arrayBuffer());
      for (let offset = 0; offset < bytes.length; offset += 1024 * 1024) {
        target.write(bytes.subarray(offset, offset + 1024 * 1024));
        progress.push(performance.now());
        await delay(500);
      }
      target.end();
    },
  });
  const started = performance.now();
  const result = await startDownload().done;
  console.info(
    `Idle-timeout download regression: ${Math.round(performance.now() - started)} ms`,
  );
  expect(result.status).toBe(0);
  const path = resolve(directory, pdfName);
  expect(JSON.parse(result.stdout)).toEqual({
    path,
    size: bytes.length,
    sha256: digest(bytes),
  });
  expect(digest(await readFile(path))).toBe(digest(bytes));
  expect(await readdir(directory)).toEqual([pdfName]);
  expect(progress.at(-1)! - progress[0]).toBeGreaterThan(10_000);
}, 30_000);

it('a real download that stops progressing reports an idle timeout and removes its partial file', async () => {
  await attachFile(app, machine.token, { bytes: Buffer.alloc(4096, 129) });
  await proxy({
    deliver: async (source, target) => {
      target.write(Buffer.from(await source.arrayBuffer()).subarray(0, 32));
      await once(target, 'close');
    },
  });
  failure(await startDownload().done, timedOut);
  expect(await readdir(directory)).toEqual([]);
}, 20_000);
