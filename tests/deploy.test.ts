import { spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { delimiter, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  type Command,
  DeployError,
  deploy,
  type Resources,
  resources,
  type Shell,
} from '../scripts/lib/deploy.ts';
import { testEnvironment } from '../scripts/lib/test-environment.ts';

const bound: Resources = {
  database: 'nook',
  bucket: 'nook-files',
  index: 'nook-memories',
};
const hostname = 'synthetic.nook.test';
const main = 'a'.repeat(40);
const requiredSecrets = [
  'ACCESS_ISSUER',
  'ACCESS_AUDIENCE',
  'OWNER_EMAIL',
  'VAULT_KEY',
];

interface Account {
  bucket: boolean;
  database: boolean;
  index: boolean;
  metadata: boolean;
  /** Metadata checks that still report the index missing after its creation. */
  metadataDelay: number;
  secrets: string[] | 'fail';
  failing?: string;
  status: string;
  head: string;
}

const installed = (): Account => ({
  bucket: true,
  database: true,
  index: true,
  metadata: true,
  metadataDelay: 0,
  secrets: [...requiredSecrets, 'UNRELATED_NAME_CANARY'],
  status: '',
  head: main,
});
const empty = (): Account => ({
  ...installed(),
  bucket: false,
  database: false,
  index: false,
  metadata: false,
  secrets: [],
});

const wrangler = (...args: string[]) => ['pnpm', 'exec', 'wrangler', ...args];
const checks = [
  ['git', 'status', '--porcelain'],
  ['git', 'ls-remote', '--exit-code', 'origin', 'refs/heads/main'],
  ['git', 'rev-parse', 'HEAD'],
];
const metadataList = wrangler(
  'vectorize',
  'list-metadata-index',
  'nook-memories',
  '--json',
);

/** A Cloudflare account and git checkout that answer like Wrangler and git. */
function fake(account: Account) {
  const calls: { command: string[]; quiet?: boolean }[] = [];
  let enqueued = false;
  const listing = (exists: boolean, name: string) =>
    JSON.stringify(
      exists ? [{ name: 'unrelated' }, { name }] : [{ name: 'unrelated' }],
    );
  const outputs: Record<string, () => string> = {
    'git status --porcelain': () => account.status,
    'git ls-remote --exit-code origin refs/heads/main': () =>
      `${main}\trefs/heads/main\n`,
    'git rev-parse HEAD': () => `${account.head}\n`,
    'r2 bucket list': () =>
      `Listing buckets...\nname:           unrelated-bucket\ncreation_date:  2026-10-01\n${
        account.bucket
          ? 'name:           nook-files\ncreation_date:  2026-10-01\n'
          : ''
      }`,
    'd1 list --json': () => listing(account.database, 'nook'),
    'vectorize list --json': () => listing(account.index, 'nook-memories'),
    'vectorize list-metadata-index nook-memories --json': () => {
      if (enqueued && account.metadataDelay-- <= 0) account.metadata = true;
      return JSON.stringify(
        account.metadata
          ? [{ propertyName: 'bucket', indexType: 'String' }]
          : [],
      );
    },
    'secret list --format json': () =>
      JSON.stringify(
        (account.secrets as string[]).map((name) => ({
          name,
          type: 'secret_text',
        })),
      ),
  };
  const effects: Record<string, () => void> = {
    build: () => {},
    'r2 bucket create nook-files': () => {
      account.bucket = true;
    },
    'd1 create nook': () => {
      account.database = true;
    },
    'd1 migrations apply DB --remote': () => {},
    'vectorize create nook-memories --dimensions 1024 --metric cosine': () => {
      account.index = true;
    },
    'vectorize create-metadata-index nook-memories --property-name bucket --type string':
      () => {
        enqueued = true;
      },
    [`deploy --domain ${hostname}`]: () => {},
  };
  const key = (command: Command) =>
    command.join(' ').replace(/^pnpm (exec wrangler )?/, '');
  const failed = (command: Command) =>
    account.failing === key(command) ||
    (key(command) === 'secret list --format json' &&
      account.secrets === 'fail');
  const shell: Shell = {
    show(command) {
      calls.push({ command: [...command] });
      const effect = effects[key(command)];
      if (!effect) throw new Error(`Unexpected command ${command.join(' ')}`);
      if (failed(command)) return false;
      effect();
      return true;
    },
    read(command, quiet) {
      calls.push({ command: [...command], ...(quiet ? { quiet } : {}) });
      const output = outputs[key(command)];
      if (!output) throw new Error(`Unexpected command ${command.join(' ')}`);
      return failed(command) ? undefined : output();
    },
    async wait(milliseconds) {
      calls.push({ command: ['wait', String(milliseconds)] });
    },
  };
  return { shell, commands: () => calls.map((call) => call.command), calls };
}

async function refusal(account: Account, host: string | undefined) {
  const { shell, commands } = fake(account);
  const error = await deploy(host, shell, bound).catch((caught) => caught);
  expect(error).toBeInstanceOf(DeployError);
  return { message: (error as DeployError).message, commands: commands() };
}

it('E24: a first deployment builds, creates storage, migrates before deploying the Worker, then checks secret names', async () => {
  const { shell, commands } = fake(empty());
  const notice = await deploy(hostname, shell, bound);
  expect(commands()).toEqual([
    ...checks,
    ['pnpm', 'build'],
    wrangler('r2', 'bucket', 'list'),
    wrangler('r2', 'bucket', 'create', 'nook-files'),
    wrangler('d1', 'list', '--json'),
    wrangler('d1', 'create', 'nook'),
    wrangler('d1', 'migrations', 'apply', 'DB', '--remote'),
    wrangler('vectorize', 'list', '--json'),
    wrangler(
      'vectorize',
      'create',
      'nook-memories',
      '--dimensions',
      '1024',
      '--metric',
      'cosine',
    ),
    metadataList,
    wrangler(
      'vectorize',
      'create-metadata-index',
      'nook-memories',
      '--property-name',
      'bucket',
      '--type',
      'string',
    ),
    metadataList,
    wrangler('deploy', '--domain', hostname),
    wrangler('secret', 'list', '--format', 'json'),
  ]);
  expect(notice).toBe(
    `Missing Worker secrets: ${requiredSecrets.join(', ')}. See docs/install.md#7-set-the-worker-secrets.`,
  );
});

it('E23: an update reuses every resource, creates nothing, and a re-run after a first deployment creates nothing either', async () => {
  const { shell, commands } = fake(installed());
  expect(await deploy(hostname, shell, bound)).toBeUndefined();
  expect(commands().filter((command) => command.includes('create'))).toEqual(
    [],
  );
  expect(commands().at(-2)).toEqual(wrangler('deploy', '--domain', hostname));

  const account = empty();
  await deploy(hostname, fake(account).shell, bound);
  const rerun = fake(account);
  await deploy(hostname, rerun.shell, bound);
  expect(
    rerun
      .commands()
      .filter((command) => command.some((part) => part.startsWith('create'))),
  ).toEqual([]);
});

it('E23: deployment waits for a delayed metadata index and deploys only after it is ready', async () => {
  const { shell, commands } = fake({
    ...installed(),
    metadata: false,
    metadataDelay: 2,
  });
  await deploy(hostname, shell, bound);
  const observed = commands();
  expect(observed.filter((command) => command[0] === 'wait')).toEqual([
    ['wait', '3000'],
    ['wait', '3000'],
  ]);
  expect(
    observed.findIndex((command) => command[3] === 'deploy'),
  ).toBeGreaterThan(
    observed.findLastIndex((command) =>
      command.includes('list-metadata-index'),
    ),
  );
});

it('E23: deployment stops without deploying when the metadata index never becomes ready', async () => {
  const { message, commands } = await refusal(
    {
      ...installed(),
      metadata: false,
      metadataDelay: Number.POSITIVE_INFINITY,
    },
    hostname,
  );
  expect(message).toBe('Metadata index did not become ready.');
  expect(
    commands.filter((command) => command.includes('list-metadata-index')),
  ).toHaveLength(21);
  expect(commands.filter((command) => command[0] === 'wait')).toHaveLength(19);
  expect(commands.some((command) => command[3] === 'deploy')).toBe(false);
});

it.each([
  ['complete', installed().secrets, undefined],
  [
    'issuer-only',
    ['ACCESS_ISSUER'],
    'Missing Worker secrets: ACCESS_AUDIENCE, OWNER_EMAIL, VAULT_KEY. See docs/install.md#7-set-the-worker-secrets.',
  ],
  [
    'list-failed',
    'fail',
    'The Worker secret check could not run. See docs/install.md#7-set-the-worker-secrets.',
  ],
] as const)(
  'installation E9: the secret check names only missing required secrets and hides its own errors: %s',
  async (_state, secrets, expected) => {
    const { shell, calls } = fake({
      ...installed(),
      secrets: secrets as Account['secrets'],
    });
    const notice = await deploy(hostname, shell, bound);
    expect(notice).toBe(expected);
    expect(notice ?? '').not.toContain('UNRELATED_NAME_CANARY');
    expect(calls.at(-1)).toEqual({
      command: wrangler('secret', 'list', '--format', 'json'),
      quiet: true,
    });
  },
);

it.each([
  [
    `deploy --domain ${hostname}`,
    `pnpm exec wrangler deploy --domain ${hostname} failed.`,
  ],
  ['r2 bucket list', 'pnpm exec wrangler r2 bucket list failed.'],
  ['build', 'pnpm build failed.'],
  [
    'd1 migrations apply DB --remote',
    'pnpm exec wrangler d1 migrations apply DB --remote failed.',
  ],
])(
  'a failed step stops the deployment before anything after it: %s',
  async (failing, expected) => {
    const { message, commands } = await refusal(
      { ...empty(), failing },
      hostname,
    );
    expect(message).toBe(expected);
    const stopped = commands.findIndex((command) =>
      command.join(' ').endsWith(failing),
    );
    expect(stopped).toBe(commands.length - 1);
  },
);

it('deploy ships only main: uncommitted changes stop it before any build or Cloudflare call', async () => {
  const { message, commands } = await refusal(
    {
      ...installed(),
      status: '?? stray.ts\n',
    },
    hostname,
  );
  expect(message).toMatch(/changes that are not committed/);
  expect(commands).toEqual([checks[0]]);
});

it('deploy ships only main: a checkout at another commit stops it and names both commits', async () => {
  const { message, commands } = await refusal(
    {
      ...installed(),
      head: 'b'.repeat(40),
    },
    hostname,
  );
  expect(message).toContain('b'.repeat(12));
  expect(message).toContain('a'.repeat(12));
  expect(message).toContain('git switch --detach origin/main');
  expect(commands).toEqual(checks);
});

it('deploy ships only main: an unreachable origin stops it', async () => {
  const { message, commands } = await refusal(
    {
      ...installed(),
      failing: 'git ls-remote --exit-code origin refs/heads/main',
    },
    hostname,
  );
  expect(message).toBe(
    'git ls-remote --exit-code origin refs/heads/main failed.',
  );
  expect(commands).toEqual(checks.slice(0, 2));
});

it.each([
  [undefined, 'Usage: pnpm run deploy <hostname>'],
  ['https://nook.example.com', 'without https:// or a path'],
  ['nook.example.com/', 'without https:// or a path'],
  ['localhost', 'without https:// or a path'],
])(
  'the hostname is checked before anything runs: %s',
  async (host, expected) => {
    const { message, commands } = await refusal(installed(), host);
    expect(message).toContain(expected);
    expect(commands).toEqual([]);
  },
);

it('resource names come from the Worker bindings in wrangler.jsonc', async () => {
  const config = JSON.parse(await readFile('wrangler.jsonc', 'utf8'));
  expect(resources(config)).toEqual(bound);
  expect(() => resources({ ...config, vectorize: [] })).toThrow(
    new DeployError('wrangler.jsonc has no MEMORY_INDEX.'),
  );
});

it('pnpm run deploy wires the real processes: it refuses a dirty checkout and deploys a clean main', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  expect(pkg.scripts.deploy).toBe('node scripts/deploy.ts');
  const directory = await mkdtemp(resolve('.local', 'deploy-entry-'));
  const calls = resolve(directory, 'calls.json');
  try {
    await mkdir(resolve(directory, 'home'));
    await writeFile(
      resolve(directory, 'git'),
      `#!/usr/bin/env node
const args = process.argv.slice(2).join(' ');
if (args === 'status --porcelain') process.stdout.write(process.env.FIXTURE_STATUS);
else if (args.startsWith('ls-remote')) console.log('${main}\\trefs/heads/main');
else if (args === 'rev-parse HEAD') console.log('${main}');
else process.exit(99);
`,
    );
    await writeFile(
      resolve(directory, 'pnpm'),
      `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
const args = process.argv.slice(2);
const calls = JSON.parse(readFileSync(${JSON.stringify(calls)}, 'utf8'));
calls.push(args);
writeFileSync(${JSON.stringify(calls)}, JSON.stringify(calls));
const command = args.slice(2).join(' ');
if (command === 'r2 bucket list') console.log('name: nook-files');
else if (command.startsWith('d1 list')) console.log(JSON.stringify([{ name: 'nook' }]));
else if (command.startsWith('vectorize list ')) console.log(JSON.stringify([{ name: 'nook-memories' }]));
else if (command.startsWith('vectorize list-metadata-index')) console.log(JSON.stringify([{ propertyName: 'bucket', indexType: 'String' }]));
else if (command.startsWith('secret list')) console.log(JSON.stringify([{ name: 'ACCESS_ISSUER' }]));
`,
    );
    await chmod(resolve(directory, 'git'), 0o755);
    await chmod(resolve(directory, 'pnpm'), 0o755);
    const entry = (status: string) => {
      const environment = testEnvironment(resolve(directory, 'home'), {
        PATH: `${directory}${delimiter}${process.env.PATH}`,
      });
      return spawnSync('node', ['scripts/deploy.ts', hostname], {
        env: { ...environment, FIXTURE_STATUS: status },
        encoding: 'utf8',
        timeout: 10_000,
      });
    };

    await writeFile(calls, '[]');
    const dirty = entry(' M wrangler.jsonc\n');
    expect(dirty.status).toBe(1);
    expect(dirty.stderr).toMatch(/changes that are not committed/);
    expect(JSON.parse(await readFile(calls, 'utf8'))).toEqual([]);

    const clean = entry('');
    expect(clean.status, clean.stderr).toBe(0);
    expect(clean.stderr).toContain(
      'Missing Worker secrets: ACCESS_AUDIENCE, OWNER_EMAIL, VAULT_KEY.',
    );
    const observed = JSON.parse(await readFile(calls, 'utf8')) as string[][];
    expect(observed.map((args) => args.join(' '))).toContain(
      `exec wrangler deploy --domain ${hostname}`,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
