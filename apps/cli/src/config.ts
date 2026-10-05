import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, resolve } from 'node:path';
import { Effect } from 'effect';
import { CliFailure } from './errors.ts';

export function installationOrigin(input: string) {
  const url = new URL(input);
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (
    !supportedProtocol(url, local) ||
    url.username ||
    url.password ||
    url.pathname !== '/' ||
    url.search ||
    url.hash
  )
    throw new CliFailure(
      'Use the HTTPS origin of your Nook installation, without a path, query, or credentials.',
    );
  return url.origin;
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
export const readConfig = Effect.tryPromise({
  try: async () => {
    let text: string;
    try {
      text = await readFile(configPath(), 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    const data = JSON.parse(text) as { url?: unknown };
    if (typeof data.url !== 'string') throw new Error();
    return installationOrigin(data.url);
  },
  catch: () => new CliFailure('Could not read the Nook configuration.'),
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
