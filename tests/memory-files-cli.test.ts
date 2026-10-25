import {
  lstat,
  mkdir,
  readdir,
  readFile,
  stat,
  symlink,
  truncate,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import { auditRows } from './support/audit.ts';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  seedMemories,
} from './support/memory.ts';
import {
  attachFile,
  clearFileState,
  digest,
  fileBucket,
  fileMachine,
  fileMemory,
  fileObjects,
  fileSnapshot,
  maximumBucket,
  maximumFile,
  pdfName,
  seedFileMemory,
  seedUsage,
} from './support/memory-files.ts';
import {
  configureFilesCli,
  fileTransport,
} from './support/memory-files-cli.ts';
import { previousFilesWorker } from './support/memory-files-previous-worker.ts';
import {
  type FilesRuntime,
  filesRuntime,
} from './support/memory-files-runtime.ts';
import { expectOutput } from './support/private-assertions.ts';
import { expectNoValue } from './support/vault.ts';

const cliPackage = JSON.parse(
  await readFile('apps/cli/package.json', 'utf8'),
) as { version: string };

let app: FilesRuntime;
let keyring: PrivateKeyring;
let keyrings: PrivateKeyring[];
let machine: Awaited<ReturnType<typeof fileMachine>>;
let transports: Awaited<ReturnType<typeof fileTransport>>[];
beforeAll(async () => {
  app = await filesRuntime();
});
afterAll(() => app?.close());
beforeEach(async () => {
  transports = [];
  keyrings = [];
  await clearFileState(app);
  machine = await seedFileMemory(app);
  await useMachine(machine.token);
});
afterEach(async () => {
  for (const transport of transports) await transport.close();
  for (const fixture of keyrings) await fixture.close();
});
async function useMachine(token: string) {
  keyring = await privateKeyring();
  keyrings.push(keyring);
  await configureFilesCli(keyring, app.origin, token);
}
const attach = (path: string, id = fileMemory) =>
  keyring.start(['memory', 'attach', id, path]).done;
const download = (
  name = pdfName,
  args: string[] = [],
  directory = keyring.home,
  id = fileMemory,
) =>
  keyring.start(['memory', 'download', id, name, ...args], {}, '', directory)
    .done;
async function proxy(options: Parameters<typeof fileTransport>[1] = {}) {
  const transport = await fileTransport(app, options);
  transports.push(transport);
  await configureFilesCli(keyring, transport.origin, machine.token);
  return transport;
}
function publicFailure(
  result: { status: number; stdout: string; stderr: string },
  message: string,
) {
  expect(result.status).toBe(1);
  expectOutput(result.stdout + result.stderr, message, true);
}

it('E1/E2/E3: real CLI creates, retries and replaces a basename with exact one-object JSON results', async () => {
  const directory = resolve(keyring.home, 'input');
  await mkdir(directory);
  const path = resolve(directory, pdfName);
  const bytes = Buffer.alloc(2_418_734, 61);
  await writeFile(path, bytes);
  const original = (
    await memoryClient(app, '2026-07-28').call('get', { id: fileMemory })
  ).structuredContent;
  const result = await attach(path);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const metadata = {
    id: fileMemory,
    bucket: fileBucket,
    name: pdfName,
    mediaType: 'application/pdf',
    size: bytes.length,
    sha256: digest(bytes),
    outcome: 'created',
    replacedSha256: null,
  };
  expect(result.stdout.trim().split('\n')).toHaveLength(1);
  expect(JSON.parse(result.stdout)).toEqual(metadata);
  const current = (
    await memoryClient(app, '2026-07-28').call('get', { id: fileMemory })
  ).structuredContent;
  expect(current).toMatchObject({
    version: original?.version,
    updatedAt: original?.updatedAt,
  });
  const before = await fileSnapshot(app);
  const retried = await attach(path);
  expect(retried.status).toBe(0);
  expect(JSON.parse(retried.stdout)).toEqual({
    ...metadata,
    outcome: 'unchanged',
  });
  expect(await fileSnapshot(app)).toEqual(before);
  await writeFile(path, Buffer.from('a changed PDF'));
  const replacement = await attach(path);
  expect(replacement.status).toBe(0);
  expect(JSON.parse(replacement.stdout)).toEqual({
    ...metadata,
    size: 13,
    sha256: digest(Buffer.from('a changed PDF')),
    outcome: 'replaced',
    replacedSha256: metadata.sha256,
  });
  expect(await fileObjects(app)).toHaveLength(1);
  const rows = await auditRows(app);
  expect(rows.map((r) => r.outcome).sort()).toEqual([
    'file_attached',
    'file_replaced',
  ]);
  for (const row of rows)
    expect(row).toMatchObject({
      machine_id: machine.id,
      machine_name: 'LG16',
      bucket: fileBucket,
      memory_id: fileMemory,
      file_name: pdfName,
      client_name: 'nook',
      client_version: cliPackage.version,
    });
});
it('E4: one 25 MiB real-process round trip is byte-identical; one extra byte is refused before any request', async () => {
  const transport = await proxy();
  const source = resolve(keyring.home, 'limit.bin');
  const destination = resolve(keyring.home, 'downloaded.bin');
  const bytes = Buffer.alloc(maximumFile, 137);
  await writeFile(source, bytes);
  const started = performance.now();
  try {
    const uploaded = await attach(source);
    expect(uploaded.status).toBe(0);
    expect(JSON.parse(uploaded.stdout)).toMatchObject({
      size: maximumFile,
      sha256: digest(bytes),
    });
    const received = await download('limit.bin', ['--output', destination]);
    expect(received.status).toBe(0);
    expect(received.stderr).toBe('');
    expect(JSON.parse(received.stdout)).toEqual({
      path: destination,
      size: maximumFile,
      sha256: digest(bytes),
    });
    expect(digest(await readFile(destination))).toBe(digest(bytes));
  } finally {
    console.info(
      `E4 single 25 MiB CLI attempt: ${Math.round(performance.now() - started)} ms`,
    );
  }
  await truncate(source, maximumFile + 1);
  const count = transport.requests.length;
  const refused = await attach(source);
  expect(refused.status).toBe(1);
  expect(refused.stdout + refused.stderr).toMatch(/25 MiB/);
  expect(refused.stdout).toBe('A file can be at most 25 MiB.\n');
  expect(refused.stderr).toBe('');
  expect(transport.requests).toHaveLength(count);
}, 30_000);
it('E5: CLI quota failure reports the exact usage the Worker refused', async () => {
  await seedUsage(app, maximumBucket - 100);
  const path = resolve(keyring.home, 'quota.bin');
  await writeFile(path, Buffer.alloc(101));
  publicFailure(
    await attach(path),
    `${fileBucket} files use 1,073,741,724 of 1,073,741,824 bytes; quota.bin needs 101.`,
  );
});
it('E6: the CLI uses the basename, downloads a 255-byte Unicode name and rejects 256 bytes before a request', async () => {
  const transport = await proxy();
  const input = resolve(keyring.home, 'nested');
  const output = resolve(keyring.home, 'elsewhere');
  await mkdir(input);
  await mkdir(output);
  const name = `${'é'.repeat(125)}a.pdf`;
  const path = resolve(input, name);
  await writeFile(path, Buffer.from('Unicode filename fixture'));
  const result = await attach(path);
  expect(result.status).toBe(0);
  expect(JSON.parse(result.stdout).name).toBe(name);
  const saved = await download(name, [], output);
  expect(saved.status).toBe(0);
  expect(digest(await readFile(resolve(output, name)))).toBe(
    digest(await readFile(path)),
  );
  const count = transport.requests.length;
  // Filesystems reject a 256-byte basename; download still exercises CLI name validation.
  publicFailure(
    await download(`${'é'.repeat(126)}.pdf`),
    'A file name can be at most 255 UTF-8 bytes.',
  );
  expect(transport.requests).toHaveLength(count);
});
it('E11: CLI reports readable-but-unwritable, unreadable and revoked credentials without storing anything', async () => {
  const path = resolve(keyring.home, 'guide.pdf');
  await writeFile(path, Buffer.from('authorization fixture'));
  await seedMemories(app, [memoryFixture(602, { bucket: 'me' })]);
  publicFailure(
    await attach(path, memoryId(602)),
    'Access to this bucket is forbidden.',
  );
  const other = await fileMachine(app, ['personal'], 'other');
  const originalMachine = keyring;
  await useMachine(other.token);
  const otherPath = resolve(keyring.home, 'guide.pdf');
  await writeFile(otherPath, await readFile(path));
  publicFailure(await attach(otherPath), 'Memory not found.');
  keyring = originalMachine;
  await (await app.mf.getD1Database('DB'))
    .prepare('DELETE FROM machine_tokens WHERE id=?')
    .bind(machine.id)
    .run();
  publicFailure(
    await attach(path),
    `This machine's token is no longer valid. Run: nook logout && nook login ${app.origin}`,
  );
  expect(await fileObjects(app)).toEqual([]);
  expect(await auditRows(app)).toEqual([]);
});
it.each(['.', '..', 'a\\b.pdf'])(
  'E6: CLI refuses an invalid basename %j before any network request',
  async (name) => {
    const transport = await proxy();
    const result = await attach(name);
    expect(result.status).toBe(1);
    expect(result.stdout + result.stderr).toMatch(
      /file name|filename|Unicode|InvalidFile/i,
    );
    expect(transport.requests).toEqual([]);
    expect(await fileObjects(app)).toEqual([]);
    expect(await auditRows(app)).toEqual([]);
  },
);
it('E12: attaching against a previous Worker gives the specific unsupported-files message', async () => {
  const previous = await previousFilesWorker();
  try {
    const previousMachine = await seedFileMemory(previous);
    await configureFilesCli(keyring, previous.origin, previousMachine.token);
    const path = resolve(keyring.home, 'guide.pdf');
    await writeFile(path, Buffer.from('previous Worker fixture'));
    publicFailure(await attach(path), 'This Nook does not support files yet.');
  } finally {
    await previous.close();
  }
});
it('E13: another real CLI machine downloads into another directory and emits only absolute-path metadata', async () => {
  const bytes = Buffer.alloc(2_418_734, 79);
  const stored = await attachFile(app, machine.token, { bytes });
  const other = await fileMachine(app, [fileBucket], 'second-machine');
  await useMachine(other.token);
  const directory = resolve(keyring.home, 'second-machine');
  await mkdir(directory);
  const result = await download(pdfName, [], directory);
  expect(result.status).toBe(0);
  expect(result.stderr).toBe('');
  const path = resolve(directory, pdfName);
  expect(JSON.parse(result.stdout)).toEqual({
    path,
    size: bytes.length,
    sha256: stored.sha256,
  });
  expect(digest(await readFile(path))).toBe(stored.sha256);
  expect(
    (await auditRows(app)).filter((r) => r.outcome === 'file_downloaded'),
  ).toEqual([
    expect.objectContaining({
      machine_id: other.id,
      machine_name: 'second-machine',
      memory_id: fileMemory,
      file_name: pdfName,
      file_sha256: stored.sha256,
      file_size: bytes.length,
    }),
  ]);
});
it('E14/E17: real CLI masks unreadable ids and reports a missing file without bytes or audit', async () => {
  await attachFile(app, machine.token);
  const before = await fileSnapshot(app);
  publicFailure(await download('missing.pdf'), 'File not found.');
  const other = await fileMachine(app, ['personal'], 'other');
  await useMachine(other.token);
  for (const id of [fileMemory, memoryId(999999)])
    publicFailure(
      await download(pdfName, [], keyring.home, id),
      'Memory not found.',
    );
  expect(await fileSnapshot(app)).toEqual(before);
});
it.each(['file', 'directory', 'dangling symlink'] as const)(
  'E15: an existing %s is refused before any request and never overwritten, including --output',
  async (kind) => {
    const transport = await proxy();
    const target = resolve(keyring.home, pdfName);
    const sentinel = resolve(keyring.home, 'sentinel');
    const absent = resolve(keyring.home, 'symlink-target');
    await writeFile(sentinel, 'existing content');
    if (kind === 'file') await writeFile(target, 'existing content');
    if (kind === 'directory') await mkdir(target);
    // A dangling link exists only to lstat; following it would find nothing.
    if (kind === 'dangling symlink') await symlink(absent, target);
    const before = await lstat(target);
    for (const args of [[], ['--output', target]]) {
      publicFailure(
        await download(pdfName, args),
        `Refusing to overwrite ${target}. Pass --output <path>.`,
      );
      expect(transport.requests).toEqual([]);
      expect(await lstat(target)).toMatchObject({
        ino: before.ino,
        mode: before.mode,
        size: before.size,
        mtimeMs: before.mtimeMs,
      });
      expect(await readFile(sentinel, 'utf8')).toBe('existing content');
      await expect(lstat(absent)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  },
);
it('E15: --output writes to the requested path, refuses stdout and never emits file bytes', async () => {
  const transport = await proxy();
  const bytes = Buffer.from(
    'synthetic bytes that belong only in the destination',
  );
  await attachFile(app, machine.token, { bytes });
  const output = resolve(keyring.home, 'chosen.pdf');
  const saved = await download(pdfName, ['--output', output]);
  expect(saved.status).toBe(0);
  expectNoValue(saved.stdout + saved.stderr, [bytes.toString()]);
  expect(JSON.parse(saved.stdout)).toEqual({
    path: output,
    size: bytes.length,
    sha256: digest(bytes),
  });
  expect(digest(await readFile(output))).toBe(digest(bytes));
  const count = transport.requests.length;
  expect((await download(pdfName, ['--output', '-'])).status).toBe(1);
  expect(transport.requests).toHaveLength(count);
});
it.each(['truncated', 'wrong-digest'] as const)(
  'E16: a %s real download leaves neither destination nor temporary file',
  async (fault) => {
    await attachFile(app, machine.token);
    await proxy({
      after: async (response, path) => {
        if (!path.includes('/files/') || response.status !== 200)
          return response;
        const bytes = Buffer.from(await response.arrayBuffer());
        if (fault === 'wrong-digest') bytes[0] ^= 255;
        return new Response(
          fault === 'truncated' ? bytes.subarray(0, bytes.length - 1) : bytes,
          { status: 200, headers: response.headers },
        );
      },
    });
    const directory = resolve(keyring.home, 'downloads');
    await mkdir(directory);
    const before = (await readdir(directory)).sort();
    const result = await download(pdfName, [], directory);
    publicFailure(
      result,
      'The file changed while downloading; nothing was written. Download it again.',
    );
    expect((await readdir(directory)).sort()).toEqual(before);
    await expect(stat(resolve(directory, pdfName))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  },
);
it('E16: EEXIST during publication preserves a competing destination and cleans its temporary file', async () => {
  await attachFile(app, machine.token);
  const directory = resolve(keyring.home, 'downloads');
  await mkdir(directory);
  const destination = resolve(directory, pdfName);
  let reached = false;
  await proxy({
    after: async (response, path) => {
      if (path.includes('/files/') && response.status === 200) {
        reached = true;
        await writeFile(destination, 'another process won', { flag: 'wx' });
      }
      return response;
    },
  });
  const before = (await readdir(directory)).sort();
  const result = await download(pdfName, [], directory);
  expect(
    reached,
    'The competing create occurs after a genuine R2-backed download starts',
  ).toBe(true);
  publicFailure(
    result,
    `Refusing to overwrite ${destination}. Pass --output <path>.`,
  );
  expect(await readFile(destination, 'utf8')).toBe('another process won');
  expect((await readdir(directory)).sort()).toEqual(
    [...before, pdfName].sort(),
  );
});

it.each([
  { name: 'EMPTY.unknown', bytes: 0, mediaType: 'application/octet-stream' },
  { name: 'GUIDE.PDF', bytes: 21, mediaType: 'application/pdf' },
])(
  'CLI infers $mediaType for $name and round-trips $bytes bytes',
  async ({ name, bytes: size, mediaType }) => {
    const path = resolve(keyring.home, name);
    const bytes = Buffer.alloc(size, 149);
    await writeFile(path, bytes);
    const uploaded = await attach(path);
    expect(uploaded.status).toBe(0);
    expect(uploaded.stderr).toBe('');
    expect(JSON.parse(uploaded.stdout)).toEqual({
      id: fileMemory,
      bucket: fileBucket,
      name,
      mediaType,
      size,
      sha256: digest(bytes),
      outcome: 'created',
      replacedSha256: null,
    });
    const destination = resolve(keyring.home, 'downloaded');
    const received = await download(name, ['--output', destination]);
    expect(received.status).toBe(0);
    expect(received.stderr).toBe('');
    expect(JSON.parse(received.stdout)).toEqual({
      path: destination,
      size,
      sha256: digest(bytes),
    });
    expect(digest(await readFile(destination))).toBe(digest(bytes));
  },
);
it('CLI rejects an upload response whose digest differs from the local digest without exposing bytes', async () => {
  const bytes = Buffer.from(`upload-canary-${crypto.randomUUID()}`);
  const path = resolve(keyring.home, 'upload.bin');
  await writeFile(path, bytes);
  const transport = await proxy({
    after: async (response) => {
      if (response.status !== 200) return response;
      return Response.json({
        ...(await response.json()),
        sha256: '0'.repeat(64),
      });
    },
  });
  const result = await attach(path);
  publicFailure(result, 'Could not verify the uploaded file. Attach it again.');
  expectNoValue(result.stdout + result.stderr, [bytes.toString()]);
  expect(transport.requests).toHaveLength(1);
});
it.each(['missing digest', 'invalid digest', 'missing size'] as const)(
  'CLI refuses download metadata with %s and removes its temporary file',
  async (fault) => {
    await attachFile(app, machine.token);
    await proxy({
      after: async (response) => {
        const headers = new Headers(response.headers);
        if (fault === 'missing digest') headers.delete('x-nook-sha256');
        if (fault === 'invalid digest') headers.set('x-nook-sha256', 'invalid');
        if (fault === 'missing size') headers.delete('content-length');
        return new Response(response.body, {
          status: response.status,
          headers,
        });
      },
    });
    const directory = resolve(keyring.home, 'downloads');
    await mkdir(directory);
    publicFailure(
      await download(pdfName, [], directory),
      'The file changed while downloading; nothing was written. Download it again.',
    );
    expect(await readdir(directory)).toEqual([]);
  },
);
it.each(['missing.bin', 'directory'])(
  'CLI refuses unreadable source %s before a request',
  async (name) => {
    const transport = await proxy();
    const path = resolve(keyring.home, name);
    if (name === 'directory') await mkdir(path);
    publicFailure(await attach(path), `Could not read ${path}.`);
    expect(transport.requests).toEqual([]);
  },
);
it('CLI refuses an unwritable download location before a request', async () => {
  const transport = await proxy();
  const path = resolve(keyring.home, 'absent', 'download.bin');
  publicFailure(
    await download(pdfName, ['--output', path]),
    `Could not write ${path}.`,
  );
  expect(transport.requests).toEqual([]);
});
