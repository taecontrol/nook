import { createHash, randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { link, lstat, open, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fileLimits, validateFileName } from '@nook/contract';
import { Effect, Stream } from 'effect';
import { CliFailure, type RequestFailure } from './errors.ts';
import {
  transferTimedOut,
  transferTimeoutMessage,
} from './file-transfer-client.ts';
import type { Host } from './host.ts';
import { session } from './session.ts';

const mediaTypes: Readonly<Record<string, string>> = {
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.csv': 'text/csv',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml',
  '.html': 'text/html',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
};
function validName(name: string) {
  const message = validateFileName(name);
  return message ? Effect.fail(new CliFailure(message)) : Effect.void;
}
function requireSize(size: number) {
  if (size > fileLimits.bytes)
    throw new CliFailure('A file can be at most 25 MiB.');
}
function readUpload(path: string) {
  return Effect.tryPromise({
    try: async (signal) => {
      const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
      try {
        const info = await file.stat();
        if (!info.isFile()) throw new CliFailure(`Could not read ${path}.`);
        requireSize(info.size);
        const chunks: Buffer[] = [];
        // The inclusive end bounds reads even if the source grows after stat.
        for await (const chunk of file.createReadStream({
          end: fileLimits.bytes,
          autoClose: false,
          signal,
        }))
          chunks.push(chunk);
        const bytes = Buffer.concat(chunks);
        requireSize(bytes.length);
        return bytes;
      } finally {
        await file.close();
      }
    },
    catch: (error) =>
      error instanceof CliFailure
        ? error
        : new CliFailure(`Could not read ${path}.`),
  });
}
function fileFailure(error: RequestFailure) {
  if (error.server.tag === 'TimeoutError')
    return new CliFailure(transferTimeoutMessage);
  if (error.server.tag === 'NotFound')
    return new CliFailure('This Nook does not support files yet.');
  if (error.server.tag === 'Forbidden')
    return new CliFailure('Access to this bucket is forbidden.');
  return error.publicMessage ? new CliFailure(error.publicMessage) : error;
}

export function memoryAttach(
  host: Host,
  id: string,
  path: string,
  write: (message: string) => void,
) {
  return Effect.gen(function* () {
    const name = basename(path);
    yield* validName(name);
    const bytes = yield* readUpload(path);
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const mediaType =
      mediaTypes[extname(name).toLowerCase()] ?? 'application/octet-stream';
    const { request } = yield* session(host, { transfer: true });
    const attached = yield* request((api, headers) =>
      api.machine.attachFile({
        params: { id, name },
        headers: { ...headers, 'content-type': mediaType },
        payload: bytes,
      }),
    ).pipe(Effect.mapError(fileFailure));
    if (attached.sha256 !== sha256)
      return yield* Effect.fail(
        new CliFailure('Could not verify the uploaded file. Attach it again.'),
      );
    write(JSON.stringify(attached));
  });
}

function overwrite(path: string) {
  return new CliFailure(`Refusing to overwrite ${path}. Pass --output <path>.`);
}
function requireAbsent(path: string) {
  return Effect.tryPromise({
    try: async () => {
      try {
        await lstat(path);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
        throw error;
      }
      throw overwrite(path);
    },
    catch: (error) =>
      error instanceof CliFailure
        ? error
        : new CliFailure(`Could not inspect ${path}.`),
  });
}
function downloadChanged() {
  return new CliFailure(
    'The file changed while downloading; nothing was written. Download it again.',
  );
}
function downloadFailure(error: unknown) {
  return transferTimedOut(error)
    ? new CliFailure(transferTimeoutMessage)
    : downloadChanged();
}
function downloadMetadata(headers: Readonly<Record<string, string>>) {
  const length = headers['content-length'] ?? '';
  const sha256 = headers['x-nook-sha256'] ?? '';
  const size = Number(length);
  if (
    !/^\d+$/.test(length) ||
    size > fileLimits.bytes ||
    !/^[0-9a-f]{64}$/.test(sha256)
  )
    return Effect.fail(downloadChanged());
  return Effect.succeed({ size, sha256 });
}
function temporaryFile(path: string) {
  const temporary = join(dirname(path), `.nook-download-${randomUUID()}.tmp`);
  return Effect.acquireRelease(
    Effect.tryPromise({
      try: () => open(temporary, 'wx', 0o600),
      catch: () => new CliFailure(`Could not write ${path}.`),
    }).pipe(Effect.map((file) => ({ file, temporary }))),
    ({ file, temporary }) =>
      Effect.promise(async () => {
        try {
          await file.close();
        } finally {
          await removeTemporary(temporary);
        }
      }),
  );
}
async function removeTemporary(temporary: string) {
  try {
    await unlink(temporary);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
function sameFile(
  left: { dev: bigint; ino: bigint },
  right: { dev: bigint; ino: bigint },
) {
  return left.dev === right.dev && left.ino === right.ino;
}
function publishFile(
  target: Effect.Success<ReturnType<typeof temporaryFile>>,
  path: string,
) {
  return Effect.tryPromise({
    try: async () => {
      const verified = await target.file.stat({ bigint: true });
      let published = false;
      try {
        if (
          !sameFile(verified, await lstat(target.temporary, { bigint: true }))
        )
          throw downloadChanged();
        await link(target.temporary, path);
        published = true;
        if (!sameFile(verified, await lstat(path, { bigint: true })))
          throw downloadChanged();
      } catch (error) {
        // EEXIST never grants ownership of the destination name.
        if (published) await unlink(path);
        throw error;
      }
    },
    catch: (error) => {
      if (error instanceof CliFailure) return error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST')
        return overwrite(path);
      if ((error as NodeJS.ErrnoException).code === 'ENOENT')
        return downloadChanged();
      return new CliFailure(`Could not write ${path}.`);
    },
  }).pipe(Effect.uninterruptible);
}
function receiveFile<E>(
  stream: Stream.Stream<Uint8Array, E>,
  target: Effect.Success<ReturnType<typeof temporaryFile>>,
  expected: { size: number; sha256: string },
  path: string,
) {
  return Effect.gen(function* () {
    const hash = createHash('sha256');
    let size = 0;
    yield* Stream.runForEach(
      stream.pipe(Stream.mapError(downloadFailure)),
      (chunk) => {
        size += chunk.byteLength;
        if (size > expected.size) return Effect.fail(downloadChanged());
        return Effect.tryPromise({
          try: () => target.file.writeFile(chunk),
          catch: () => new CliFailure(`Could not write ${path}.`),
        }).pipe(Effect.tap(() => Effect.sync(() => hash.update(chunk))));
      },
    );
    if (size !== expected.size || hash.digest('hex') !== expected.sha256)
      return yield* Effect.fail(downloadChanged());
    yield* publishFile(target, path);
  });
}
export function memoryDownload(
  host: Host,
  id: string,
  name: string,
  output: string | undefined,
  write: (message: string) => void,
) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* validName(name);
      if (output === '-')
        return yield* Effect.fail(
          new CliFailure('Use --output <path> to save the file.'),
        );
      const path = resolve(output ?? name);
      yield* requireAbsent(path);
      const target = yield* temporaryFile(path);
      const { request } = yield* session(host, { transfer: true });
      const [stream, response] = yield* request((api, headers) =>
        api.machine.downloadFile({
          params: { id, name },
          headers,
          responseMode: 'decoded-and-response',
        }),
      ).pipe(Effect.mapError(fileFailure));
      const expected = yield* downloadMetadata(response.headers);
      yield* receiveFile(stream, target, expected, path);
      return { path, ...expected };
    }),
  ).pipe(
    Effect.tap((saved) => Effect.sync(() => write(JSON.stringify(saved)))),
  );
}
