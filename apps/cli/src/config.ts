import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Effect } from 'effect';
import { CliFailure } from './errors.ts';

export function installationOrigin(
  input: string,
): Effect.Effect<string, CliFailure> {
  return Effect.gen(function* () {
    const url = URL.parse(input);
    if (
      !url ||
      !supportedProtocol(
        url,
        ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname),
      ) ||
      url.username ||
      url.password ||
      url.pathname !== '/' ||
      url.search ||
      url.hash
    )
      return yield* Effect.fail(
        new CliFailure(
          'Use the HTTPS origin of your Nook installation, without a path, query, or credentials.',
        ),
      );
    return url.origin;
  });
}
function supportedProtocol(url: URL, local: boolean) {
  return url.protocol === 'https:' || (local && url.protocol === 'http:');
}
function configPath() {
  const configured = process.env.XDG_CONFIG_HOME;
  return resolve(
    configured && isAbsolute(configured)
      ? configured
      : resolve(homedir(), '.config'),
    'nook/config.json',
  );
}
export const readConfig = Effect.gen(function* () {
  const path = configPath();
  const text = yield* Effect.tryPromise({
    try: async () => {
      try {
        return await readFile(path, 'utf8');
      } catch (error) {
        if (
          error instanceof Error &&
          'code' in error &&
          error.code === 'ENOENT'
        )
          return undefined;
        throw error;
      }
    },
    catch: () => new CliFailure('Could not read the Nook configuration.'),
  });
  if (text === undefined) return;
  const data: unknown = yield* Effect.try({
    try: () => JSON.parse(text),
    catch: () => new CliFailure('Could not read the Nook configuration.'),
  });
  if (
    data === null ||
    typeof data !== 'object' ||
    !('url' in data) ||
    typeof data.url !== 'string'
  )
    return yield* Effect.fail(
      new CliFailure('Could not read the Nook configuration.'),
    );
  return yield* installationOrigin(data.url).pipe(
    Effect.mapError(
      () => new CliFailure('Could not read the Nook configuration.'),
    ),
  );
});
export function writeConfig(url: string) {
  return Effect.tryPromise({
    try: async () => {
      const path = configPath();
      await mkdir(dirname(path), { recursive: true, mode: 0o700 });
      const temporary = `${path}.${crypto.randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ url })}\n`, {
        mode: 0o600,
      });
      await rename(temporary, path);
    },
    catch: () => new CliFailure('Could not save the Nook installation URL.'),
  });
}
