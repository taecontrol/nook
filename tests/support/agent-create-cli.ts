import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, expect } from 'vitest';
import { evidenceRoot } from '../../scripts/lib/instrument.ts';
import { createdPath } from './agent-create.ts';
import { privateKeyring } from './cli.ts';
import { issueGrant } from './grants.ts';
import { vaultRuntime } from './vault.ts';

export let app: Awaited<ReturnType<typeof vaultRuntime>>;
export let keyring: Awaited<ReturnType<typeof privateKeyring>>;
export let token: string;
// Each test gets a fresh Worker, D1 and keyring configured for work/acme.
export function setupAgentCreateCli() {
  beforeEach(async () => {
    app = await vaultRuntime();
    keyring = await privateKeyring();
    ({ token } = await issueGrant(app, ['work/acme']));
    await configure(app.origin);
    return async () => {
      await keyring.close();
      await app.close();
    };
  });
}
export async function configure(origin: string, credential = token) {
  await mkdir(dirname(keyring.config), { recursive: true });
  await writeFile(keyring.config, JSON.stringify({ url: origin }));
  expect(await keyring.store(origin, credential)).toBe(0);
}
export async function transcript() {
  return readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => '');
}
export function childEnv() {
  return process.env.COVERAGE_RUN
    ? { NOOK_CLI_COVERAGE: resolve(evidenceRoot, `cli-${randomUUID()}.json`) }
    : {};
}
export const unconfirmed = `Could not confirm whether ${createdPath} was stored.`;
