import { stripVTControlCharacters } from 'node:util';

export type Command = readonly string[];

/** The processes a deployment starts, so tests can replace Cloudflare and git. */
export interface Shell {
  show(command: Command): boolean;
  read(command: Command, quiet?: boolean): string | undefined;
  wait(milliseconds: number): Promise<void>;
}

export interface Resources {
  readonly database: string;
  readonly bucket: string;
  readonly index: string;
}

/** A deployment that stopped; its message tells the person what to do. */
export class DeployError extends Error {}

interface WranglerConfig {
  d1_databases: { binding: string; database_name: string }[];
  r2_buckets: { binding: string; bucket_name: string }[];
  vectorize: { binding: string; index_name: string }[];
}

export function resources(config: WranglerConfig): Resources {
  const named = <T extends { binding: string }>(list: T[], binding: string) => {
    const found = list.find((entry) => entry.binding === binding);
    if (!found) throw new DeployError(`wrangler.jsonc has no ${binding}.`);
    return found;
  };
  return {
    database: named(config.d1_databases, 'DB').database_name,
    bucket: named(config.r2_buckets, 'FILES').bucket_name,
    index: named(config.vectorize, 'MEMORY_INDEX').index_name,
  };
}

const requiredSecrets = [
  'ACCESS_ISSUER',
  'ACCESS_AUDIENCE',
  'OWNER_EMAIL',
  'VAULT_KEY',
];
const secretsGuide = 'docs/install.md#7-set-the-worker-secrets';
const metadataChecks = 20;
const metadataPause = 3_000;

const wrangler = (...args: string[]): Command => [
  'pnpm',
  'exec',
  'wrangler',
  ...args,
];

function run(shell: Shell, command: Command) {
  if (!shell.show(command))
    throw new DeployError(`${command.join(' ')} failed.`);
}

function read(shell: Shell, command: Command) {
  const output = shell.read(command);
  if (output === undefined)
    throw new DeployError(`${command.join(' ')} failed.`);
  return output;
}

const named = (shell: Shell, command: Command, name: string) =>
  (JSON.parse(read(shell, command)) as { name: string }[]).some(
    (entry) => entry.name === name,
  );

function checkHostname(hostname: string | undefined): string {
  if (!hostname) throw new DeployError('Usage: pnpm run deploy <hostname>');
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(hostname))
    throw new DeployError(
      `${hostname} is not a hostname. Pass the hostname alone, such as nook.example.com, without https:// or a path.`,
    );
  return hostname;
}

function requireMain(shell: Shell) {
  const status = ['git', 'status', '--porcelain', '--untracked-files=all'];
  if (read(shell, status).trim())
    throw new DeployError(
      'This checkout has changes that are not committed. Deploy ships only main: commit or remove them, then run it again.',
    );
  // ls-remote matches ref name suffixes, so a branch such as
  // a/refs/heads/main also matches; only the exact ref counts.
  const main = read(shell, [
    'git',
    'ls-remote',
    '--exit-code',
    'origin',
    'refs/heads/main',
  ])
    .split('\n')
    .map((line) => line.split('\t'))
    .find(([, ref]) => ref === 'refs/heads/main')?.[0];
  if (!main) throw new DeployError('origin has no main branch.');
  const head = read(shell, ['git', 'rev-parse', 'HEAD']).trim();
  if (head !== main)
    throw new DeployError(
      `This checkout is at ${head.slice(0, 12)}, but main on origin is at ${main.slice(0, 12)}. Deploy ships only main: run git fetch origin && git switch --detach origin/main, then run it again.`,
    );
}

function provisionBucket(shell: Shell, bucket: string) {
  // A FORCE_COLOR environment colors Wrangler's labelled listing.
  const listing = stripVTControlCharacters(
    read(shell, wrangler('r2', 'bucket', 'list')),
  );
  const names = [...listing.matchAll(/^name:\s+(\S+)\s*$/gm)].map(
    (match) => match[1],
  );
  if (!names.includes(bucket))
    run(shell, wrangler('r2', 'bucket', 'create', bucket));
}

function provisionDatabase(shell: Shell, database: string) {
  if (!named(shell, wrangler('d1', 'list', '--json'), database))
    run(shell, wrangler('d1', 'create', database));
}

const metadataReady = (shell: Shell, index: string) =>
  (
    JSON.parse(
      read(
        shell,
        wrangler('vectorize', 'list-metadata-index', index, '--json'),
      ),
    ) as { propertyName: string; indexType?: string }[]
  ).some(
    (entry) =>
      entry.propertyName === 'bucket' &&
      entry.indexType?.toLowerCase() === 'string',
  );

/**
 * Vectorize creates metadata indexes asynchronously. The Worker must not write
 * vectors before the bucket index exists, so deployment waits for it.
 */
async function provisionIndex(shell: Shell, index: string) {
  if (!named(shell, wrangler('vectorize', 'list', '--json'), index))
    run(
      shell,
      wrangler(
        'vectorize',
        'create',
        index,
        '--dimensions',
        '1024',
        '--metric',
        'cosine',
      ),
    );
  if (metadataReady(shell, index)) return;
  run(
    shell,
    wrangler(
      'vectorize',
      'create-metadata-index',
      index,
      '--property-name',
      'bucket',
      '--type',
      'string',
    ),
  );
  for (let check = 1; !metadataReady(shell, index); check++) {
    if (check === metadataChecks)
      throw new DeployError('Metadata index did not become ready.');
    await shell.wait(metadataPause);
  }
}

/** Names only: the listing never carries values, and no other name is repeated. */
function secretNotice(shell: Shell): string | undefined {
  const listing = shell.read(
    wrangler('secret', 'list', '--format', 'json'),
    true,
  );
  let names: string[];
  try {
    names = (JSON.parse(listing ?? '') as { name: string }[]).map(
      (secret) => secret.name,
    );
  } catch {
    return `The Worker secret check could not run. See ${secretsGuide}.`;
  }
  const missing = requiredSecrets.filter((name) => !names.includes(name));
  if (missing.length === 0) return undefined;
  return `Missing Worker secrets: ${missing.join(', ')}. See ${secretsGuide}.`;
}

export async function deploy(
  hostname: string | undefined,
  shell: Shell,
  bound: Resources,
): Promise<string | undefined> {
  const domain = checkHostname(hostname);
  requireMain(shell);
  run(shell, ['pnpm', 'install', '--frozen-lockfile']);
  run(shell, ['pnpm', 'build']);
  provisionBucket(shell, bound.bucket);
  provisionDatabase(shell, bound.database);
  run(shell, wrangler('d1', 'migrations', 'apply', 'DB', '--remote'));
  await provisionIndex(shell, bound.index);
  run(shell, wrangler('deploy', '--domain', domain));
  return secretNotice(shell);
}
