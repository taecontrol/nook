import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  app,
  configure,
  keyring,
  setupAgentCreateCli,
} from './support/agent-create-cli.ts';
import { importArgs } from './support/agent-import-cli.ts';
import { machineProxy } from './support/machine-proxy.ts';
import { expectOutput } from './support/private-assertions.ts';
import { expectNoValue, secretInput, secretRows } from './support/vault.ts';

setupAgentCreateCli();
it('Import does not retry a failed listing or start writes, and keeps the network guidance on stdout', async () => {
  const value = secretInput().value;
  await writeFile(resolve(keyring.home, '.env'), `KEY=${value}`);
  const requests: { method: string; path: string }[] = [];
  const proxy = await machineProxy(app, (request) => {
    requests.push(request);
    return 503;
  });
  try {
    await configure(proxy.origin);
    const result = await keyring.start(importArgs()).done;
    expect(result.status).toBe(1);
    expectOutput(
      result.stdout,
      `Could not reach ${proxy.origin}. Try again.`,
      true,
    );
    expectOutput(result.stderr, '', true);
    expectNoValue(result.stdout + result.stderr, [value]);
    expect(requests).toEqual([
      { method: 'GET', path: '/api/machine/secrets?bucket=work%2Facme' },
    ]);
    expect(await secretRows(app)).toEqual([]);
  } finally {
    await proxy.close();
  }
});
