import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { beforeEach, expect, it } from 'vitest';
import { type PrivateKeyring, privateKeyring } from './support/cli.ts';
import { expectOutput } from './support/private-assertions.ts';

let keyring: PrivateKeyring;
beforeEach(async () => {
  keyring = await privateKeyring();
  return () => keyring.close();
});
it('Login maps an unparsable URL to origin guidance before using the keyring', async () => {
  const result = await keyring.start(['login', 'not a url']).done;
  expect(result.status).toBe(1);
  expectOutput(
    result.stdout,
    'Use the HTTPS origin of your Nook installation, without a path, query, or credentials.',
    true,
  );
  expectOutput(result.stderr, '', true);
  expect(
    await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
  ).toBe('');
});
it.each(['not a url', 'https://nook.test/path'])(
  'An invalid configured origin %s keeps configuration guidance on stderr',
  async (url) => {
    await mkdir(dirname(keyring.config), { recursive: true });
    await writeFile(keyring.config, JSON.stringify({ url }));
    const result = await keyring.start(['mcp-header']).done;
    expect(result.status).toBe(1);
    expectOutput(result.stdout, '', true);
    expectOutput(result.stderr, 'Could not read the Nook configuration.', true);
    expect(
      await readFile(resolve(keyring.home, 'argv'), 'utf8').catch(() => ''),
    ).toBe('');
  },
);
