import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Log, LogLevel } from 'miniflare';
import { expect, it } from 'vitest';
import { testEnvironment } from '../scripts/lib/test-environment.ts';
import {
  app,
  configure,
  keyring,
  setupAgentCreateCli,
  transcript,
} from './support/agent-create-cli.ts';
import {
  claimNames,
  claudeSession,
  codexClaim,
  codexSession,
  codexThread,
  decoys,
  sessionTransport,
} from './support/agent-session.ts';
import { acmePath, auditPageData, auditRows } from './support/audit.ts';
import { createSecret, expectNoValue, secretInput } from './support/vault.ts';

setupAgentCreateCli();
const args = (name = 'GH_TOKEN', path = acmePath) => [
  'run',
  '--secret',
  `${name}=${path}`,
  '--purpose',
  'session acceptance',
  '--',
  process.execPath,
  '-e',
  'process.stdout.write("unchanged-output")',
];
// Precedence and validation are pinned in-process by
// agent-session-contract.test.ts; these rows prove the CLI reads the real
// environment and sends a claim, or omits the key, through request and audit.
const cases = [
  {
    label: 'E2: Codex subagent session and thread',
    env: { CODEX_SESSION_ID: codexSession, CODEX_THREAD_ID: codexThread },
    claim: codexClaim,
  },
  {
    label: 'E7: no harness omits the wire key and reads as null',
    env: {},
    claim: null,
  },
];
it.each(cases)('$label', async ({ env, claim }) => {
  expect(
    (await createSecret(app, secretInput({ name: 'GH_TOKEN' }))).status,
  ).toBe(201);
  const transport = await sessionTransport(app);
  try {
    await configure(transport.origin);
    const result = await keyring.start(args(), env).done;
    expect(result).toMatchObject({
      status: 0,
      stdout: 'unchanged-output',
      stderr: '',
    });
    expect(transport.requests).toHaveLength(1);
    if (claim) expect(transport.requests[0].body.agentSession).toEqual(claim);
    else expect(transport.requests[0].body).not.toHaveProperty('agentSession');
    expect((await auditPageData(app)).entries[0]).toHaveProperty(
      'agentSession',
      claim,
    );
  } finally {
    await transport.close();
  }
});
it('E9: only claim variables reach requests and audit; decoys never reach output or Worker logs', async () => {
  expect(
    (await createSecret(app, secretInput({ name: 'GH_TOKEN' }))).status,
  ).toBe(201);
  const logs: string[] = [];
  class PrivateLog extends Log {
    override log(message: string) {
      logs.push(message);
    }
  }
  await app.setBindings(app.bindings, {
    log: new PrivateLog(LogLevel.DEBUG),
    handleRuntimeStdio: (stdout, stderr) => {
      for (const stream of [stdout, stderr])
        stream.on('data', (chunk) => logs.push(String(chunk)));
    },
  });
  const transport = await sessionTransport(app);
  try {
    await configure(transport.origin);
    const result = await keyring.start(args(), {
      CODEX_SESSION_ID: codexSession,
      ...decoys,
    }).done;
    expect(result.status).toBe(0);
    expectNoValue(
      JSON.stringify(transport.requests) +
        JSON.stringify(await auditRows(app)) +
        logs.join('') +
        result.stdout +
        result.stderr +
        (await transcript()),
      Object.values(decoys),
    );
    expect(transport.requests[0].body.agentSession).toEqual({
      agent: 'codex',
      session: codexSession,
    });
  } finally {
    await transport.close();
  }
});
it('E10: CLI denial outside the grant records its claim and delivers no value', async () => {
  const input = secretInput({ bucket: 'personal', name: 'PRIVATE_KEY' });
  expect((await createSecret(app, input)).status).toBe(201);
  const transport = await sessionTransport(app);
  try {
    await configure(transport.origin);
    const result = await keyring.start(args('T', 'personal/PRIVATE_KEY'), {
      CLAUDE_CODE_SESSION_ID: claudeSession,
    }).done;
    expect(result.status).toBe(1);
    expectNoValue(result.stdout + result.stderr, [input.value]);
    expect(transport.requests[0].status).toBe(403);
    expect((await auditPageData(app)).entries[0]).toMatchObject({
      outcome: 'denied',
      agentSession: { agent: 'claude-code', session: claudeSession },
    });
  } finally {
    await transport.close();
  }
});
// Every reserved name is pinned in agent-session-contract.test.ts; one name
// per source proves each parser consults the reservation.
it.each([
  { name: 'CODEX_THREAD_ID', source: 'flag' },
  { name: 'NOOK_AGENT_SESSION', source: 'nook.json' },
])(
  'E12: $source refuses reserved $name before any HTTP or keyring lookup',
  async ({ name, source }) => {
    const transport = await sessionTransport(app);
    try {
      await configure(transport.origin);
      const before = await transcript();
      if (source === 'nook.json')
        await writeFile(
          resolve(keyring.home, 'nook.json'),
          JSON.stringify({ secrets: { [name]: acmePath } }),
        );
      const command =
        source === 'flag'
          ? args(name)
          : ['run', '--purpose', 'reserved', '--', process.execPath, '-e', ''];
      const result = await keyring.start(command).done;
      expect(result.status).toBe(1);
      expect(result.stdout + result.stderr).toContain(
        `Environment name ${name} is reserved for agent session claims.`,
      );
      expect(transport.requests).toEqual([]);
      expect(await transcript()).toBe(before);
      expect(await auditRows(app)).toEqual([]);
    } finally {
      await transport.close();
    }
  },
);
it('test processes omit inherited claims and decoys but allow explicit synthetic values', () => {
  for (const name of [...claimNames, ...Object.keys(decoys)]) {
    const previous = process.env[name];
    process.env[name] = 'developer-private-marker';
    try {
      expect(testEnvironment(keyring.home)).not.toHaveProperty(name);
      expect(testEnvironment(keyring.home, { [name]: 'synthetic' })[name]).toBe(
        'synthetic',
      );
    } finally {
      if (previous === undefined) delete process.env[name];
      else process.env[name] = previous;
    }
  }
});
