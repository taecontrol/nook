import { createHash, randomBytes } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { Log, LogLevel } from 'miniflare';
import { beforeEach, expect, it } from 'vitest';
import {
  acmePath,
  auditPageData,
  auditRows,
  runFixture,
  useEntry,
} from './support/audit.ts';
import { privateKeyring } from './support/cli.ts';
import { revokeMachine } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { createSecret, expectNoValue, secretInput } from './support/vault.ts';

let app: Awaited<ReturnType<typeof runFixture>>;
let keyring: Awaited<ReturnType<typeof privateKeyring>>;
let project: string;
let file: string;
let checkpoints: string[];
let privateValues: string[];
let outputs: string[];
let values: Record<string, string>;
const childFile = resolve('tests/support/run-child.ts');
const mappings = { GH_TOKEN: acmePath, DB_URL: 'work/acme/DB_URL' };
const usage =
  'Usage: nook run --secret ENV=bucket/NAME --purpose "…" -- <command>';
class PrivateLog extends Log {
  messages: string[] = [];
  constructor() {
    super(LogLevel.VERBOSE);
  }
  protected log(message: string) {
    this.messages.push(message);
  }
}
function expectPrivate(text: string) {
  expectNoValue(
    text,
    privateValues.flatMap((value) => [
      value,
      JSON.stringify(value).slice(1, -1),
    ]),
  );
}
async function transcript() {
  return readFile(resolve(keyring.home, 'argv'), 'utf8').catch((error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  });
}
async function config(secrets: Record<string, unknown>, path = file) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify({ secrets }));
}
async function cli(args: string[], cwd = project) {
  const result = await keyring.start(args, {}, '', cwd).done;
  outputs.push(result.stdout + result.stderr);
  expectPrivate(result.stdout + result.stderr);
  return result;
}
function runArgs(command: string[], flags: string[] = []) {
  return [
    'run',
    ...flags.flatMap((entry) => ['--secret', entry]),
    '--purpose',
    'dev server',
    '--',
    ...command,
  ];
}
function probe(entries: Record<string, string | undefined>, exit = 0) {
  return [
    process.execPath,
    childFile,
    'mappings',
    JSON.stringify(
      Object.entries(entries).map(([name, value]) => [
        name,
        value === undefined
          ? null
          : createHash('sha256').update(value).digest('hex'),
      ]),
    ),
    String(exit),
  ];
}
const requests = (kind: 'value' | 'listing') =>
  checkpoints.filter((label) => label === `/${kind}-request`).length;
async function auditPaths() {
  const rows = await auditRows(app);
  expectPrivate(JSON.stringify(rows));
  return rows.map((row) => String(row.path)).sort();
}
async function beforeAccess(args: string[], message: string) {
  const before = await transcript();
  checkpoints.length = 0;
  const result = await cli(args);
  expect(result.status).toBe(1);
  expectOutput(result.stdout + result.stderr, message, true);
  expect((await transcript()) === before).toBe(true);
  expect(checkpoints).toEqual([]);
  expect(await auditPaths()).toEqual([]);
}
beforeEach(async () => {
  checkpoints = [];
  outputs = [];
  app = await runFixture(['work/acme'], async (label) => {
    checkpoints.push(label);
    return true;
  });
  keyring = await privateKeyring();
  project = await realpath(keyring.home);
  project = resolve(project, 'project');
  file = resolve(project, 'nook.json');
  await mkdir(project);
  values = { GH_TOKEN: app.input.value };
  for (const name of ['DB_URL', 'OTHER', 'EXTRA', 'X']) {
    const input = secretInput({
      name,
      value: `\n${randomBytes(24).toString('base64')} 秘密\r\n\t `,
    });
    expect((await createSecret(app, input)).status).toBe(201);
    values[name] = input.value;
  }
  privateValues = [...Object.values(values), app.token, app.key];
  const log = new PrivateLog();
  const workerOutput = ['', ''];
  await app.setBindings(app.bindings, {
    log,
    handleRuntimeStdio: (stdout, stderr) => {
      [stdout, stderr].forEach((input, index) => {
        input.setEncoding('utf8');
        input.on('data', (chunk) => {
          workerOutput[index] += String(chunk);
        });
        createInterface({ input }).on('line', (line) =>
          log.messages.push(line),
        );
      });
    },
  });
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: app.origin }));
  expect(await keyring.store(app.origin, app.token)).toBe(0);
  checkpoints.length = 0;
  return async () => {
    try {
      for (const text of [
        ...outputs,
        ...log.messages,
        ...workerOutput,
        JSON.stringify(await auditRows(app)),
        await transcript(),
      ])
        expectPrivate(text);
    } finally {
      await keyring.close();
      await app.close();
    }
  };
});
it('E1/E14: project mappings preserve both exact values, child exit 42 and silence', async () => {
  await config(mappings);
  let result = await cli(
    runArgs(probe({ GH_TOKEN: values.GH_TOKEN, DB_URL: values.DB_URL }, 42)),
  );
  expect(result.status).toBe(42);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  expect(requests('value')).toBe(1);
  result = await cli(runArgs(['/usr/bin/true']));
  expect(result.status).toBe(0);
  expect(result.stdout).toBe('');
  expect(result.stderr).toBe('');
});
it('E2: flags override a mapped name before the single value request and audit', async () => {
  await config(mappings);
  const result = await cli(
    runArgs(probe({ GH_TOKEN: values.OTHER, DB_URL: values.DB_URL }), [
      'GH_TOKEN=work/acme/OTHER',
    ]),
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  expect(requests('value')).toBe(1);
  expect(await auditPaths()).toEqual(['work/acme/DB_URL', 'work/acme/OTHER']);
});
it('E3: flags add variables to all file mappings', async () => {
  await config(mappings);
  const result = await cli(
    runArgs(
      probe({
        GH_TOKEN: values.GH_TOKEN,
        DB_URL: values.DB_URL,
        EXTRA: values.EXTRA,
      }),
      ['EXTRA=work/acme/EXTRA'],
    ),
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(result.stderr).toBe('');
  expect(requests('value')).toBe(1);
  expect(await auditPaths()).toEqual([
    'work/acme/DB_URL',
    'work/acme/EXTRA',
    acmePath,
  ]);
});
it('E4: aliases fetch once and audit each distinct path once with one purpose and run id', async () => {
  await config({ ...mappings, ALIAS: mappings.DB_URL });
  const result = await cli(
    runArgs(
      probe({
        GH_TOKEN: values.GH_TOKEN,
        DB_URL: values.DB_URL,
        ALIAS: values.DB_URL,
      }),
    ),
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(requests('value')).toBe(1);
  const { entries } = await auditPageData(app);
  expectPrivate(JSON.stringify(entries));
  expect(entries).toHaveLength(2);
  expect(new Set(entries.map((entry) => useEntry(entry).runId)).size).toBe(1);
  for (const entry of entries)
    expect(entry).toMatchObject({
      outcome: 'delivered',
      purpose: 'dev server',
      workingDirectory: project,
    });
  expect(entries.map((entry) => entry.path).sort()).toEqual([
    'work/acme/DB_URL',
    acmePath,
  ]);
});
it('E5: discovery walks parents and only the nearest file supplies mappings', async () => {
  const nested = resolve(project, 'a/b');
  await mkdir(nested, { recursive: true });
  await config(mappings);
  let result = await cli(
    runArgs(probe({ GH_TOKEN: values.GH_TOKEN, DB_URL: values.DB_URL })),
    nested,
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  await config({ X: 'work/acme/X' }, resolve(project, 'a/nook.json'));
  result = await cli(
    runArgs(probe({ X: values.X, GH_TOKEN: undefined, DB_URL: undefined })),
    nested,
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(requests('value')).toBe(2);
});
it('E5: discovery starts at the real directory when entered through a symlink', async () => {
  await config(mappings);
  const nested = resolve(project, 'a/b');
  await mkdir(nested, { recursive: true });
  const link = resolve(keyring.home, 'project-link');
  await symlink(nested, link);
  const result = await cli(
    runArgs(probe({ GH_TOKEN: values.GH_TOKEN, DB_URL: values.DB_URL })),
    link,
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(
    (await auditPageData(app)).entries.every(
      (entry) =>
        entry.outcome !== 'revealed' && entry.workingDirectory === nested,
    ),
  ).toBe(true);
});
it('E6: every missing path is reported, including an absent bucket, before any child or audit', async () => {
  await config({
    GH_TOKEN: 'work/acme/ABSENT',
    DB_URL: 'work/acme/missing/DB_URL',
  });
  const marker = resolve(project, 'child-marker');
  const result = await cli(
    runArgs([process.execPath, childFile, 'mark', marker]),
  );
  expect(result.status).toBe(1);
  expectOutput(result.stdout + result.stderr, 'work/acme/ABSENT');
  expectOutput(result.stdout + result.stderr, 'work/acme/missing/DB_URL');
  expect(existsSync(marker)).toBe(false);
  expect(await auditPaths()).toEqual([]);
  expect(requests('value')).toBe(1);
});
it('E7: a denied mapped path stops the child and is the only audited path', async () => {
  await config({ ...mappings, DENIED: 'personal/finances/PLAID_SECRET' });
  const marker = resolve(project, 'child-marker');
  const result = await cli(
    runArgs([process.execPath, childFile, 'mark', marker]),
  );
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'Access to personal/finances/PLAID_SECRET is forbidden.',
    true,
  );
  expect(existsSync(marker)).toBe(false);
  expect(await auditPaths()).toEqual(['personal/finances/PLAID_SECRET']);
  expect((await auditPageData(app)).entries[0].outcome).toBe('denied');
});

const invalidCases = [
  'malformed JSON',
  'null root',
  'array root',
  'string root',
  'unknown secret key',
  'unknown policy key',
  'missing secrets',
  'null secrets',
  'array secrets',
  'string secrets',
  'invalid environment name',
  'non-string path',
  'invalid path',
  'value-like path',
  'too many paths',
] as const;
function invalidFile(kind: (typeof invalidCases)[number]) {
  const pasted = `ghp_${randomBytes(20).toString('hex')}`;
  privateValues.push(pasted);
  const cases = {
    'malformed JSON': {
      content: `{"secrets":{"GH_TOKEN":"${pasted}",`,
      message: 'malformed JSON.',
    },
    'null root': { content: 'null', message: 'expected an object.' },
    'array root': { content: '[]', message: 'expected an object.' },
    'string root': {
      content: JSON.stringify(pasted),
      message: 'expected an object.',
    },
    'unknown secret key': {
      content: JSON.stringify({ secret: mappings }),
      message: 'unknown key "secret".',
    },
    'unknown policy key': {
      content: JSON.stringify({ secrets: mappings, policy: pasted }),
      message: 'unknown key "policy".',
    },
    'missing secrets': { content: '{}', message: 'secrets must be an object.' },
    'null secrets': {
      content: '{"secrets":null}',
      message: 'secrets must be an object.',
    },
    'array secrets': {
      content: '{"secrets":[]}',
      message: 'secrets must be an object.',
    },
    'string secrets': {
      content: JSON.stringify({ secrets: pasted }),
      message: 'secrets must be an object.',
    },
    'invalid environment name': {
      content: JSON.stringify({ secrets: { '1BAD': acmePath } }),
      message: 'invalid environment name "1BAD".',
    },
    'non-string path': {
      content: '{"secrets":{"GH_TOKEN":123}}',
      message: 'secret path for GH_TOKEN must be a string.',
    },
    'invalid path': {
      content: '{"secrets":{"GH_TOKEN":"work/acme"}}',
      message: 'invalid secret path for GH_TOKEN.',
    },
    'value-like path': {
      content: JSON.stringify({ secrets: { GH_TOKEN: pasted } }),
      message: 'invalid secret path for GH_TOKEN.',
    },
    'too many paths': {
      content: JSON.stringify({
        secrets: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [
            `KEY_${i}`,
            `work/acme/KEY_${i}`,
          ]),
        ),
      }),
      message: 'secrets must map at most 20 distinct paths.',
    },
  };
  return cases[kind];
}
it.each(
  invalidCases.flatMap((kind) =>
    ['run', 'flags', 'check'].map((command) => ({ kind, command })),
  ),
)(
  'E8/E13/E14: $command rejects $kind before keyring or network',
  async ({ kind, command }) => {
    const invalid = invalidFile(kind);
    await writeFile(file, invalid.content);
    const message = `Invalid ${file}: ${invalid.message}`;
    const args =
      command === 'check'
        ? ['vault', 'check']
        : runArgs(
            ['/usr/bin/true'],
            command === 'flags' ? [`GH_TOKEN=${acmePath}`] : [],
          );
    await beforeAccess(args, message);
  },
);
it('E8: the twenty-path limit applies after merging with flags', async () => {
  await config(
    Object.fromEntries(
      Array.from({ length: 20 }, (_, i) => [`KEY_${i}`, `work/acme/KEY_${i}`]),
    ),
  );
  await beforeAccess(
    runArgs(['/usr/bin/true'], ['EXTRA=work/acme/EXTRA']),
    `Invalid ${file}: secrets must map at most 20 distinct paths.`,
  );
});
it('an invalid flag path keeps the contract guidance with a valid project file', async () => {
  await config(mappings);
  const pasted = `ghp_${randomBytes(20).toString('hex')}`;
  privateValues.push(pasted);
  await beforeAccess(
    runArgs(['/usr/bin/true'], [`GH_TOKEN=${pasted}`]),
    'Use a secret path such as work/acme/GH_TOKEN.',
  );
});
it('E9: absent mappings print usage before keyring access', async () => {
  await beforeAccess(runArgs(['/usr/bin/true']), usage);
});
it('E9: an empty file fails before keyring access and can be supplemented by flags', async () => {
  await config({});
  await beforeAccess(
    runArgs(['/usr/bin/true']),
    `No secrets are mapped in ${file}.`,
  );
  const result = await cli(
    runArgs(probe({ GH_TOKEN: values.GH_TOKEN }), [`GH_TOKEN=${acmePath}`]),
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
});
it('E10/E14: check in a subdirectory lists metadata once per distinct bucket, with no values or audit', async () => {
  await config({ ...mappings, ALIAS: mappings.DB_URL });
  const nested = resolve(project, 'a/b');
  await mkdir(nested, { recursive: true });
  const result = await cli(['vault', 'check'], nested);
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout + result.stderr,
    `All 2 secrets mapped in ${file} are available.`,
    true,
  );
  expect(requests('listing')).toBe(1);
  expect(requests('value')).toBe(0);
  expect(await auditPaths()).toEqual([]);
});
it('E11/E14: check reports every absent or denied entry, ignores healthy entries and never audits', async () => {
  await config({
    GH_TOKEN: acmePath,
    MISSING: 'work/acme/ABSENT',
    BUCKET: 'work/acme/missing/DB_URL',
    DENIED: 'personal/finances/PLAID_SECRET',
    ALIAS: 'work/acme/ABSENT',
  });
  const result = await cli(['vault', 'check']);
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    [
      'MISSING  work/acme/ABSENT  not found',
      'BUCKET  work/acme/missing/DB_URL  not found',
      "DENIED  personal/finances/PLAID_SECRET  outside this machine's grant",
      'ALIAS  work/acme/ABSENT  not found',
    ].join('\n'),
    true,
  );
  expect(requests('listing')).toBe(3);
  expect(requests('value')).toBe(0);
  expect(await auditPaths()).toEqual([]);
});
it('E10: check matches exact paths even when the same name exists in an ancestor', async () => {
  const input = secretInput({ bucket: 'work', name: 'ANCESTOR' });
  privateValues.push(input.value);
  expect((await createSecret(app, input)).status).toBe(201);
  await config({ GH_TOKEN: acmePath, ANCESTOR: 'work/acme/ANCESTOR' });
  checkpoints.length = 0;
  const result = await cli(['vault', 'check']);
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout + result.stderr,
    'ANCESTOR  work/acme/ANCESTOR  not found',
    true,
  );
  expect(requests('listing')).toBe(1);
  expect(requests('value')).toBe(0);
  expect(await auditPaths()).toEqual([]);
});
it('E12: check without a file fails before keyring access', async () => {
  await beforeAccess(
    ['vault', 'check'],
    `No nook.json in ${project} or its parents.`,
  );
});
it.each(['revoked machine', 'unavailable storage'] as const)(
  'check preserves the existing session or server guidance for %s',
  async (failure) => {
    await config(mappings);
    if (failure === 'revoked machine')
      expect((await revokeMachine(app, app.machine.id)).status).toBe(204);
    else
      await (await app.mf.getD1Database('DB'))
        .prepare('ALTER TABLE secrets RENAME TO unavailable_secrets')
        .run();
    checkpoints.length = 0;
    const result = await cli(['vault', 'check']);
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout + result.stderr,
      failure === 'revoked machine'
        ? `This machine's token is no longer valid. Run: nook login ${app.origin}`
        : `Could not reach ${app.origin}. Try again.`,
      true,
    );
    expect(requests('listing')).toBe(1);
    expect(requests('value')).toBe(0);
    expect(await auditPaths()).toEqual([]);
  },
);
it('check uses metadata even when the installation cannot decrypt values', async () => {
  await config(mappings);
  await app.setBindings({ ...app.bindings, VAULT_KEY: '' });
  const result = await cli(['vault', 'check']);
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout + result.stderr,
    `All 2 secrets mapped in ${file} are available.`,
    true,
  );
  expect(requests('listing')).toBe(1);
  expect(requests('value')).toBe(0);
  expect(await auditPaths()).toEqual([]);
});
it('an empty nearest file hides the parent and check needs no keyring or network', async () => {
  await config(mappings, resolve(keyring.home, 'nook.json'));
  await config({});
  await rm(keyring.config);
  const before = await transcript();
  const result = await cli(['vault', 'check']);
  expect(result.status).toBe(0);
  expectOutput(
    result.stdout + result.stderr,
    `All 0 secrets mapped in ${file} are available.`,
    true,
  );
  expect((await transcript()) === before).toBe(true);
  expect(checkpoints).toEqual([]);
  expect(await auditPaths()).toEqual([]);
});
it('an unreadable nearest config fails privately before keyring or network', async () => {
  await mkdir(file);
  const message = `Could not read ${file}.`;
  await beforeAccess(
    runArgs(['/usr/bin/true'], [`GH_TOKEN=${acmePath}`]),
    message,
  );
  await beforeAccess(['vault', 'check'], message);
});
it('file mappings preserve prototype-like environment names and duplicate flag rejection', async () => {
  await config(
    Object.fromEntries([
      ['__proto__', acmePath],
      ['constructor', mappings.DB_URL],
    ]),
  );
  await beforeAccess(
    runArgs(
      ['/usr/bin/true'],
      [`GH_TOKEN=${acmePath}`, 'GH_TOKEN=work/acme/OTHER'],
    ),
    'Environment name GH_TOKEN is repeated.',
  );
  const entries = Object.fromEntries([
    ['__proto__', values.GH_TOKEN],
    ['constructor', values.DB_URL],
  ]);
  const result = await cli(runArgs(probe(entries)));
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
});
it('E2/E8: a flag can reduce the merged file to twenty distinct paths; aliases do not count twice', async () => {
  const entries: Record<string, string> = {};
  const expected: Record<string, string> = {};
  for (let i = 0; i < 20; i++) {
    const input = secretInput({ name: `LIMIT_${i}` });
    privateValues.push(input.value);
    expect((await createSecret(app, input)).status).toBe(201);
    entries[`KEY_${i}`] = `work/acme/LIMIT_${i}`;
    expected[`KEY_${i}`] = input.value;
  }
  entries.KEY_20 = 'work/acme/NOT_REQUESTED';
  entries.ALIAS = entries.KEY_0;
  expected.KEY_20 = expected.KEY_0;
  expected.ALIAS = expected.KEY_0;
  await config(entries);
  checkpoints.length = 0;
  const result = await cli(
    runArgs(probe(expected), [`KEY_20=${entries.KEY_0}`]),
  );
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'true', true);
  expect(requests('value')).toBe(1);
  expect(await auditPaths()).toEqual(
    Object.values(entries)
      .filter(
        (path) => path !== 'work/acme/NOT_REQUESTED' && path !== entries.ALIAS,
      )
      .concat(entries.ALIAS)
      .sort(),
  );
  expect(await auditPaths()).toHaveLength(20);
});
