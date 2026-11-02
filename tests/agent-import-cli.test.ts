import {
  mkdir,
  readdir,
  readFile,
  realpath,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { parse } from 'dotenv';
import { expect, it } from 'vitest';
import { validateSecretName } from '../packages/contract/src/index.ts';
import { createTransport } from './support/agent-create.ts';
import {
  app,
  childEnv,
  configure,
  keyring,
  transcript,
} from './support/agent-create-cli.ts';
import {
  envFile,
  importArgs,
  importFile,
  observeArgv,
  privateValue,
  record,
  setupImportCli,
} from './support/agent-import-cli.ts';
import { codexClaim } from './support/agent-session.ts';
import { auditRows } from './support/audit.ts';
import { filesContain } from './support/cli.ts';
import { deferred } from './support/machines.ts';
import { expectOutput } from './support/private-assertions.ts';
import { testBuild } from './support/runtime.ts';
import {
  createSecret,
  decryptRow,
  expectNoValue,
  secretInput,
  secretRows,
} from './support/vault.ts';

setupImportCli();

function names(transport: Awaited<ReturnType<typeof createTransport>>) {
  return transport.bodies.map(
    (body) => (JSON.parse(body.toString()) as { name: string }).name,
  );
}
async function proxy(
  before: Parameters<typeof createTransport>[1] = () => undefined,
  after?: Parameters<typeof createTransport>[2],
) {
  const transport = await createTransport(app, before, after);
  await configure(transport.origin);
  return transport;
}
function mapping(output: string) {
  const block = output.split('\nnook.json:\n')[1];
  return block ? JSON.parse(block) : undefined;
}

it('E1/E2: imports dotenv bytes and provenance once, in file order, with one listing and private argv', async () => {
  const text = `export GH_TOKEN=${privateValue()}\r\nDB_URL="postgres://${privateValue()}@h/db" # prod\r\nCERT="${privateValue()}\\n\r\n${privateValue()}"\r\n`;
  await envFile(text);
  const transport = await proxy();
  try {
    const result = record(
      await keyring.start(
        importArgs(),
        observeArgv(),
        '',
        resolve(keyring.home, 'source'),
      ).done,
    );
    expect(result.status).toBe(0);
    expectOutput(result.stderr, '', true);
    expectOutput(
      result.stdout,
      `Imported .env into work/acme.\n  created  GH_TOKEN\n  created  DB_URL\n  created  CERT\n3 created.\n\nnook.json:\n${JSON.stringify({ secrets: { GH_TOKEN: 'work/acme/GH_TOKEN', DB_URL: 'work/acme/DB_URL', CERT: 'work/acme/CERT' } }, null, 2)}`,
      true,
    );
    const rows = await secretRows(app);
    expect(rows).toHaveLength(3);
    const expected = parse(text);
    for (const row of rows) {
      expect((await decryptRow(app.key, row)) === expected[row.name]).toBe(
        true,
      );
      expect(row.description).toBe('');
    }
    const audit = await auditRows(app);
    expect(audit).toHaveLength(3);
    for (const row of audit)
      expect(row).toMatchObject({
        outcome: 'created',
        purpose: 'migrate acme env',
        machine_name: 'work-laptop',
        working_directory: await realpath(resolve(keyring.home, 'source')),
      });
    expect(transport.listings).toEqual([
      '/api/machine/secrets?bucket=work%2Facme',
    ]);
    expect(names(transport).sort()).toEqual(['CERT', 'DB_URL', 'GH_TOKEN']);
    expect(transport.maxActive).toBeLessThanOrEqual(3);
    expect(await readdir(resolve(keyring.home, 'source'))).toEqual(['.env']);
    expect(
      (await readFile(resolve(keyring.home, 'cli-argv'), 'utf8')).includes(
        'vault',
      ),
    ).toBe(true);
  } finally {
    await transport.close();
  }
});

it('E2: the privacy oracle rejects a planted output, argv, audit or MCP fragment and a plaintext file', async () => {
  const value = privateValue();
  for (const surface of ['stdout', 'stderr', 'argv', 'audit', 'MCP']) {
    let detected = false;
    try {
      expectNoValue(`${surface}:${value.slice(-18)}`, [value.slice(-18)]);
    } catch {
      detected = true;
    }
    expect(detected).toBe(true);
  }
  const planted = resolve(keyring.home, 'planted');
  await writeFile(planted, value);
  expect(await filesContain(keyring.home, value)).toBe(true);
  await writeFile(planted, '');
});

it('E3: skips only exact-bucket existing names without requests, changes or audits; ancestor names are created', async () => {
  expect(
    (
      await createSecret(
        app,
        secretInput({ name: 'STRIPE_KEY', value: privateValue() }),
      )
    ).status,
  ).toBe(201);
  expect(
    (
      await createSecret(
        app,
        secretInput({
          bucket: 'work',
          name: 'PARENT_KEY',
          value: privateValue(),
        }),
      )
    ).status,
  ).toBe(201);
  const before = await secretRows(app);
  await envFile(`STRIPE_KEY=${privateValue()}\nPARENT_KEY=${privateValue()}`);
  const transport = await proxy();
  try {
    const result = await importFile();
    expect(result.status).toBe(0);
    expectOutput(
      result.stdout,
      'exists   STRIPE_KEY  already in work/acme; not changed',
    );
    expectOutput(result.stdout, '1 created, 1 already existed.');
    expect(mapping(result.stdout)).toEqual({
      secrets: {
        STRIPE_KEY: 'work/acme/STRIPE_KEY',
        PARENT_KEY: 'work/acme/PARENT_KEY',
      },
    });
    expect(
      (await secretRows(app)).filter((row) => row.name === 'STRIPE_KEY'),
    ).toEqual(before.filter((row) => row.name === 'STRIPE_KEY'));
    expect(await auditRows(app)).toHaveLength(1);
    expect(names(transport)).toEqual(['PARENT_KEY']);
    expect(transport.listings).toHaveLength(1);
  } finally {
    await transport.close();
  }
});

it('E4: skips empty, over-64-KiB and NUL values while storing the exact boundary', async () => {
  const exact = privateValue().padEnd(65536, 'x');
  await envFile(
    `EMPTY=\nOVER=${exact}x\nNUL="${privateValue()}\0"\nEXACT=${exact}`,
  );
  const transport = await proxy();
  try {
    const result = await importFile();
    expect(result.status).toBe(0);
    for (const line of [
      'skipped  EMPTY  empty value',
      'skipped  OVER  value over 64 KiB',
      'skipped  NUL  value contains NUL',
      '1 created, 3 skipped.',
    ])
      expectOutput(result.stdout, line);
    expect(names(transport)).toEqual(['EXACT']);
    expect(
      (await decryptRow(app.key, (await secretRows(app))[0])) === exact,
    ).toBe(true);
  } finally {
    await transport.close();
  }
});

it('E5: reports unreadable lines 4 and 9 by number only and imports the other keys', async () => {
  await envFile(
    `# comment\n\nOK=${privateValue()}\n${privateValue()}\n# five\n\n# seven\n\n${privateValue()}\nNEXT=${privateValue()}`,
  );
  const result = await importFile();
  expect(result.status).toBe(0);
  expectOutput(result.stdout, 'Lines 4, 9 are not KEY=value; not imported.');
  expect(await secretRows(app)).toHaveLength(2);
});

it('E6: one invalid name blocks every create and reports its original line and contract message', async () => {
  await envFile(`GOOD=${privateValue()}\n\ndb_url=${privateValue()}`);
  const transport = await proxy();
  try {
    const result = await importFile();
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout,
      `Nothing was imported. Fix these keys in .env and run again:\nline 3  db_url  ${validateSecretName('db_url')}`,
      true,
    );
    expect(transport.bodies).toHaveLength(0);
    expect(transport.listings).toHaveLength(1);
    expect(await secretRows(app)).toEqual([]);
  } finally {
    await transport.close();
  }
});

it.each([false, true])(
  'E7: duplicates on lines 7 and 12 block unless already in the bucket (existing=%s)',
  async (existing) => {
    if (existing)
      expect(
        (
          await createSecret(
            app,
            secretInput({ name: 'API_KEY', value: privateValue() }),
          )
        ).status,
      ).toBe(201);
    await envFile(
      `${'\n'.repeat(6)}API_KEY=${privateValue()}\n${'\n'.repeat(4)}API_KEY=${privateValue()}`,
    );
    const transport = await proxy();
    try {
      const result = await importFile();
      expect(result.status).toBe(existing ? 0 : 1);
      if (existing) {
        expect((result.stdout.match(/exists {3}API_KEY/g) ?? []).length).toBe(
          2,
        );
        expect(mapping(result.stdout)).toEqual({
          secrets: { API_KEY: 'work/acme/API_KEY' },
        });
      } else {
        expectOutput(result.stdout, 'line 7  API_KEY  duplicate');
        expectOutput(result.stdout, 'line 12  API_KEY  duplicate');
      }
      expect(transport.listings).toHaveLength(1);
      expect(transport.bodies).toHaveLength(0);
      expect(await auditRows(app)).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);

it('E7: an empty duplicate is skipped but still blocks its valid occurrence; an empty invalid name alone does not block', async () => {
  await envFile(`\nA=\n\n\nA=${privateValue()}`);
  const transport = await proxy();
  try {
    const result = await importFile();
    expect(result.status).toBe(1);
    expectOutput(result.stdout, 'line 5  A  duplicate');
    expect(transport.bodies).toHaveLength(0);
    await envFile('db_url=');
    const skipped = await importFile();
    expect(skipped.status).toBe(0);
    expectOutput(skipped.stdout, 'skipped  db_url  empty value');
    expectOutput(skipped.stdout, '1 skipped.');
    expect(mapping(skipped.stdout)).toBeUndefined();
  } finally {
    await transport.close();
  }
});

it.each([0, 101])(
  'E8: %s parsed keys refuse before keyring or any request',
  async (count) => {
    await envFile(
      Array.from(
        { length: count },
        (_, i) => `KEY_${i}=${privateValue()}`,
      ).join('\n'),
    );
    const transport = await proxy();
    try {
      const before = await transcript();
      const result = await importFile();
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout,
        count
          ? '.env has 101 keys; import at most 100 at a time.'
          : 'No keys found in .env.',
        true,
      );
      expect(transport.listings).toHaveLength(0);
      expect(transport.bodies).toHaveLength(0);
      expect((await transcript()) === before).toBe(true);
    } finally {
      await transport.close();
    }
  },
);

it('E8/budget: 100 keys finish with one listing, one create each and at most three in flight', async () => {
  await envFile(
    Array.from({ length: 100 }, (_, i) => `KEY_${i}=${privateValue()}`).join(
      '\n',
    ),
  );
  const held = deferred();
  const transport = await proxy(
    () => undefined,
    async (attempt) => {
      if (attempt <= 3) await held.promise;
      return undefined;
    },
  );
  const command = keyring.start(
    importArgs(),
    {},
    '',
    resolve(keyring.home, 'source'),
  );
  try {
    await expect.poll(() => transport.bodies.length).toBe(3);
    held.resolve();
    const result = record(await command.done);
    expect(result.status).toBe(0);
    expect(transport.listings).toHaveLength(1);
    expect(transport.bodies).toHaveLength(100);
    expect(transport.maxActive).toBe(3);
    expect(await secretRows(app)).toHaveLength(100);
  } finally {
    held.resolve();
    await command.kill();
    await command.done;
    await transport.close();
  }
});

it.each(['missing', 'directory', 'invalid UTF-8'])(
  'E9: %s file fails privately before keyring or HTTP',
  async (mode) => {
    if (mode === 'directory') await mkdir(resolve(keyring.home, 'source/.env'));
    if (mode === 'invalid UTF-8') await envFile(Buffer.from([0xc3, 0x28]));
    const transport = await proxy();
    try {
      const before = await transcript();
      const result = await importFile();
      expect(result.status).toBe(1);
      expectOutput(
        result.stdout,
        mode === 'invalid UTF-8'
          ? '.env is not valid UTF-8.'
          : 'Could not read .env.',
        true,
      );
      expect(transport.listings).toHaveLength(0);
      expect(transport.bodies).toHaveLength(0);
      expect((await transcript()) === before).toBe(true);
    } finally {
      await transport.close();
    }
  },
);

it('E9: ignores a leading UTF-8 BOM', async () => {
  const value = privateValue();
  await envFile(`\ufeffBOM_KEY=${value}`);
  const result = await importFile();
  expect(result.status).toBe(0);
  expect(
    (await decryptRow(app.key, (await secretRows(app))[0])) === value,
  ).toBe(true);
});

it.each([
  { bucket: 'work/other', message: 'Access to work/other is forbidden.' },
  { bucket: 'work/acme/missing', message: 'Bucket not found.' },
])(
  'E10: refused listing of $bucket sends no creates',
  async ({ bucket, message }) => {
    await envFile(`KEY=${privateValue()}`);
    const transport = await proxy();
    try {
      const result = await importFile(importArgs(bucket));
      expect(result.status).toBe(1);
      expectOutput(result.stdout, message, true);
      expect(transport.bodies).toHaveLength(0);
      expect(await secretRows(app)).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);

it('E10: read-only ancestor refusal settles the pool, starts no more creates and marks unsent keys not tried', async () => {
  await envFile(
    Array.from({ length: 7 }, (_, i) => `KEY_${i}=${privateValue()}`).join(
      '\n',
    ),
  );
  const held = deferred();
  const transport = await proxy(
    () => undefined,
    async () => {
      await held.promise;
      return undefined;
    },
  );
  const command = keyring.start(
    importArgs('work'),
    {},
    '',
    resolve(keyring.home, 'source'),
  );
  try {
    await expect.poll(() => transport.bodies.length).toBe(3);
    held.resolve();
    const result = record(await command.done);
    expect(result.status).toBe(1);
    expect(transport.bodies).toHaveLength(3);
    for (let i = 0; i < 3; i++)
      expectOutput(
        result.stdout,
        `failed  KEY_${i}  Access to work is forbidden.`,
      );
    for (let i = 3; i < 7; i++)
      expectOutput(result.stdout, `not tried  KEY_${i}`);
    expectOutput(result.stdout, '3 failed, 4 not tried.');
    expect(mapping(result.stdout)).toBeUndefined();
    expect(await secretRows(app)).toEqual([]);
  } finally {
    held.resolve();
    await command.kill();
    await command.done;
    await transport.close();
  }
});

it.each([
  {
    label: 'set',
    env: {
      CODEX_SESSION_ID: codexClaim.session,
      CODEX_THREAD_ID: codexClaim.thread,
    },
    claim: codexClaim,
  },
  { label: 'unset', env: {} as Record<string, string>, claim: null },
])(
  'session: each imported Created entry carries the agent session claim when it is $label',
  async ({ env, claim }) => {
    await envFile(`GH_TOKEN=${privateValue()}\nDB_URL=${privateValue()}\n`);
    const transport = await proxy();
    try {
      const result = await importFile(importArgs(), env);
      expect(result.status).toBe(0);
      expectOutput(result.stdout, '2 created.');
      expect(transport.bodies).toHaveLength(2);
      for (const body of transport.bodies) {
        const payload = JSON.parse(body.toString());
        if (claim) expect(payload.agentSession).toEqual(claim);
        else expect(payload).not.toHaveProperty('agentSession');
      }
      const audit = await auditRows(app);
      expect(audit).toHaveLength(2);
      for (const row of audit)
        expect(row).toMatchObject({
          outcome: 'created',
          agent: claim?.agent ?? null,
          agent_session: claim?.session ?? null,
          agent_thread: claim?.thread ?? null,
        });
    } finally {
      await transport.close();
    }
  },
);
it('session: a reserved claim name is imported but left out of nook.json, and the printed block runs', async () => {
  const value = privateValue();
  await envFile(
    `GH_TOKEN=${value}\nCLAUDE_CODE_SESSION_ID=${privateValue()}\n`,
  );
  const transport = await proxy();
  try {
    const result = await importFile();
    expect(result.status).toBe(0);
    expectOutput(result.stdout, '2 created.');
    expectOutput(
      result.stdout,
      'CLAUDE_CODE_SESSION_ID is reserved for agent session claims; map it in nook.json under another name.',
    );
    const block = mapping(result.stdout);
    expect(block).toEqual({ secrets: { GH_TOKEN: 'work/acme/GH_TOKEN' } });
    await writeFile(
      resolve(keyring.home, 'source', 'nook.json'),
      JSON.stringify(block),
    );
    await configure(app.origin);
    const run = record(
      await keyring.start(
        [
          'run',
          '--purpose',
          'use imported mapping',
          '--',
          process.execPath,
          '-e',
          'process.stdout.write(String(process.env.GH_TOKEN.length))',
        ],
        {},
        '',
        resolve(keyring.home, 'source'),
      ).done,
    );
    expect(run.status).toBe(0);
    expect(run.stdout).toBe(String(value.length));
  } finally {
    await transport.close();
  }
});
it.each([20, 21])(
  'session: %i stored keys print the full block and note nook run limit only above 20',
  async (count) => {
    await envFile(
      Array.from(
        { length: count },
        (_, i) => `KEY_${i}=${privateValue()}`,
      ).join('\n'),
    );
    const transport = await proxy();
    try {
      const result = await importFile();
      expect(result.status).toBe(0);
      expect(Object.keys(mapping(result.stdout).secrets)).toHaveLength(count);
      expect(
        result.stdout.includes(
          'nook run uses at most 20 secrets; keep only the ones this project needs.',
        ),
      ).toBe(count > 20);
    } finally {
      await transport.close();
    }
  },
);
it('E11: lost committed response retries the same write id and creates only one audit', async () => {
  await envFile(`KEY=${privateValue()}`);
  const transport = await proxy(
    () => undefined,
    async (attempt) => (attempt === 1 ? 'lost' : undefined),
  );
  try {
    const result = await importFile();
    expect(result.status).toBe(0);
    expectOutput(result.stdout, '1 created.');
    expect(transport.bodies).toHaveLength(2);
    expect(transport.bodies[0].equals(transport.bodies[1])).toBe(true);
    expect(await secretRows(app)).toHaveLength(1);
    expect(await auditRows(app)).toHaveLength(1);
  } finally {
    await transport.close();
  }
});

it('E12/E13: three retryable failures leave one key unconfirmed, continue others and reconcile on rerun', async () => {
  await envFile(
    `FIRST=${privateValue()}\nFAILED=${privateValue()}\nLAST=${privateValue()}`,
  );
  const transport = await proxy((_attempt, body) =>
    JSON.parse(body.toString()).name === 'FAILED'
      ? { status: 502, body: { _tag: 'FutureTransient' } }
      : undefined,
  );
  try {
    const result = await importFile();
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout,
      'unconfirmed  FAILED  could not confirm whether it was stored; run again to check',
    );
    expectOutput(result.stdout, '2 created, 1 unconfirmed.');
    expect(mapping(result.stdout)).toEqual({
      secrets: { FIRST: 'work/acme/FIRST', LAST: 'work/acme/LAST' },
    });
    expect(names(transport).filter((name) => name === 'FAILED')).toHaveLength(
      3,
    );
    expect(await auditRows(app)).toHaveLength(2);
    // The rerun reaches the Worker through a fresh, fault-free origin.
    const healthy = await proxy();
    try {
      const rerun = await importFile();
      expect(rerun.status).toBe(0);
      expectOutput(rerun.stdout, '1 created, 2 already existed.');
      expect(names(healthy)).toEqual(['FAILED']);
      expect(await auditRows(app)).toHaveLength(3);
    } finally {
      await healthy.close();
    }
  } finally {
    await transport.close();
  }
});

it.each(['SIGINT', 'SIGTERM'] as const)(
  'E13: %s after a committed write leaves a safe rerun without duplicate audit',
  async (signal) => {
    await envFile(`KEY=${privateValue()}`);
    const committed = deferred();
    const held = deferred();
    const transport = await proxy(
      () => undefined,
      async () => {
        committed.resolve();
        await held.promise;
        return 'lost';
      },
    );
    const command = keyring.start(
      importArgs(),
      {},
      '',
      resolve(keyring.home, 'source'),
    );
    try {
      await expect.poll(async () => (await secretRows(app)).length).toBe(1);
      await committed.promise;
      expect(await command.kill(signal)).toBe(true);
      const result = record(await command.done);
      expect(result.status).toBe(signal === 'SIGINT' ? 130 : 143);
      held.resolve();
      // The rerun reaches the Worker through a fresh, fault-free origin.
      const healthy = await proxy();
      try {
        const rerun = await importFile();
        expect(rerun.status).toBe(0);
        expectOutput(
          rerun.stdout,
          'exists   KEY  already in work/acme; not changed',
        );
        expect(healthy.bodies).toHaveLength(0);
        expect(await auditRows(app)).toHaveLength(1);
      } finally {
        await healthy.close();
      }
    } finally {
      held.resolve();
      await command.kill();
      await command.done;
      await transport.close();
    }
  },
);

it.each([
  {
    args: importArgs('work//acme'),
    message:
      'Separate segments with a single /, with none at the start or end.',
  },
  { args: importArgs().slice(0, 4), message: 'A purpose is required.' },
  {
    args: [...importArgs().slice(0, -1), ' '],
    message: 'Purpose must be one line of 1 to 200 characters.',
  },
  {
    args: [...importArgs().slice(0, -1), 'two\nlines'],
    message: 'Purpose must be one line of 1 to 200 characters.',
  },
  {
    args: [...importArgs(), '--description', 'no'],
    message: 'Usage: nook vault import <bucket> <file> --purpose "…"',
  },
  {
    args: ['vault', 'import', 'work/acme'],
    message: 'Usage: nook vault import <bucket> <file> --purpose "…"',
  },
])(
  'E14: invalid arguments refuse before keyring or network ($message)',
  async ({ args, message }) => {
    const transport = await proxy();
    try {
      const before = await transcript();
      const result = await importFile(args);
      expect(result.status).toBe(1);
      expectOutput(result.stdout, message, true);
      expect(transport.listings).toHaveLength(0);
      expect(transport.bodies).toHaveLength(0);
      expect((await transcript()) === before).toBe(true);
    } finally {
      await transport.close();
    }
  },
);

it('E14: disappeared cwd refuses import before keyring or network', async () => {
  const directory = resolve(keyring.home, 'gone');
  await mkdir(directory);
  const transport = await proxy();
  try {
    const before = await transcript();
    const entry = resolve(testBuild, 'cli.js');
    const script = `import { rmdirSync } from 'node:fs'; process.chdir(${JSON.stringify(directory)}); rmdirSync(${JSON.stringify(directory)}); process.argv=${JSON.stringify([process.execPath, entry, ...importArgs()])}; await import(${JSON.stringify(entry)});`;
    const result = record(
      await keyring.command(
        process.execPath,
        ['--input-type=module', '-e', script],
        childEnv(),
      ).done,
    );
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout,
      'Could not resolve the working directory.',
      true,
    );
    expect(transport.listings).toHaveLength(0);
    expect(transport.bodies).toHaveLength(0);
    expect((await transcript()) === before).toBe(true);
  } finally {
    await transport.close();
  }
});

it.each([
  { status: 403, tag: 'Forbidden' },
  { status: 404, tag: 'BucketNotFound' },
  { status: 401, tag: 'Unauthorized' },
  { status: 503, tag: 'VaultNotConfigured' },
])(
  'E10/state: first-answer $tag stops new creates and settles in-flight successes',
  async ({ status, tag }) => {
    await envFile(
      Array.from({ length: 7 }, (_, i) => `KEY_${i}=${privateValue()}`).join(
        '\n',
      ),
    );
    // KEY_1 and KEY_2 answer only 300 ms after KEY_0's refusal. Until then the
    // refusal is the only answer, so any fourth create is a CLI that ignored it.
    // After that, a success read before the refusal may legitimately free a
    // slot, so the final checks only require each key's report to match whether
    // it was sent.
    const refused = deferred();
    let sentBeforeSuccesses: string[] | undefined;
    const transport = await proxy(
      (_attempt, body) => {
        if (JSON.parse(body.toString()).name !== 'KEY_0') return undefined;
        refused.resolve();
        return {
          status,
          body: { _tag: tag, message: 'Public bucket refusal.' },
        };
      },
      async () => {
        await refused.promise;
        await sleep(300);
        sentBeforeSuccesses ??= names(transport).sort();
        return undefined;
      },
    );
    try {
      const result = await importFile();
      expect(result.status).toBe(1);
      // KEY_2 may still be on its way; nothing beyond the first three may be.
      expect(sentBeforeSuccesses).toContain('KEY_0');
      for (const name of sentBeforeSuccesses ?? [])
        expect(['KEY_0', 'KEY_1', 'KEY_2']).toContain(name);
      const sent = new Set(names(transport));
      expectOutput(result.stdout, 'failed  KEY_0');
      for (let i = 1; i < 7; i++)
        expectOutput(
          result.stdout,
          `${sent.has(`KEY_${i}`) ? 'created' : 'not tried'}  KEY_${i}`,
        );
      expect(await secretRows(app)).toHaveLength(sent.size - 1);
      expect(await auditRows(app)).toHaveLength(sent.size - 1);
    } finally {
      await transport.close();
    }
  },
);

it.each([
  { status: 409, tag: 'SecretExists' },
  { status: 403, tag: 'Forbidden' },
  { status: 404, tag: 'BucketNotFound' },
  { status: 401, tag: 'Unauthorized' },
  { status: 503, tag: 'VaultNotConfigured' },
  { status: 400, tag: 'InvalidSecret' },
])(
  'E12/state: $tag after a lost attempt stays unconfirmed and does not stop other keys',
  async ({ status, tag }) => {
    await envFile(
      Array.from({ length: 5 }, (_, i) => `KEY_${i}=${privateValue()}`).join(
        '\n',
      ),
    );
    let attempts = 0;
    const transport = await proxy((_attempt, body) => {
      if (JSON.parse(body.toString()).name !== 'KEY_0') return undefined;
      return ++attempts === 1
        ? 'lost'
        : { status, body: { _tag: tag, message: 'Public refusal.' } };
    });
    try {
      const result = await importFile();
      expect(result.status).toBe(1);
      expect(attempts).toBe(2);
      expectOutput(
        result.stdout,
        'unconfirmed  KEY_0  could not confirm whether it was stored; run again to check',
      );
      expectOutput(result.stdout, '4 created, 1 unconfirmed.');
      expect(await secretRows(app)).toHaveLength(4);
    } finally {
      await transport.close();
    }
  },
);

it('E3/state: concurrent existing names are reported and mapped, while other definitive refusals continue', async () => {
  await envFile(
    `REFUSED=${privateValue()}\nREADY=${privateValue()}\nHELD=${privateValue()}\nEXISTS=${privateValue()}`,
  );
  // READY and HELD answer only once EXISTS arrives, and EXISTS can only start
  // in the slot REFUSED freed, so a per-key refusal must not stop new creates.
  const later = deferred();
  const transport = await proxy(
    (_attempt, body) => {
      const { name } = JSON.parse(body.toString());
      if (name === 'EXISTS') later.resolve();
      return name === 'EXISTS'
        ? {
            status: 409,
            body: { _tag: 'SecretExists', message: 'Already exists.' },
          }
        : name === 'REFUSED'
          ? {
              status: 400,
              body: {
                _tag: 'InvalidSecret',
                message: 'Public per-key refusal.',
              },
            }
          : undefined;
    },
    async () => {
      await later.promise;
      return undefined;
    },
  );
  try {
    const result = await importFile();
    expect(result.status).toBe(1);
    expect(names(transport).sort()).toEqual([
      'EXISTS',
      'HELD',
      'READY',
      'REFUSED',
    ]);
    expectOutput(
      result.stdout,
      'exists   EXISTS  already in work/acme; not changed',
    );
    expectOutput(result.stdout, 'failed  REFUSED  Public per-key refusal.');
    expectOutput(result.stdout, '2 created, 1 already existed, 1 failed.');
    expect(mapping(result.stdout)).toEqual({
      secrets: {
        READY: 'work/acme/READY',
        HELD: 'work/acme/HELD',
        EXISTS: 'work/acme/EXISTS',
      },
    });
    expect(await auditRows(app)).toHaveLength(2);
  } finally {
    await transport.close();
  }
});
