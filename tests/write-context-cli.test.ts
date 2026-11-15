import { realpath, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { createArgs, createTransport } from './support/agent-create.ts';
import {
  app,
  childEnv,
  configure,
  keyring,
  setupAgentCreateCli,
} from './support/agent-create-cli.ts';
import { importArgs } from './support/agent-import-cli.ts';
import { auditRows } from './support/audit.ts';
import { expectOutput } from './support/private-assertions.ts';
import { testBuild } from './support/runtime.ts';
import { expectNoValue, secretInput } from './support/vault.ts';

setupAgentCreateCli();
it.each(['create', 'import'] as const)(
  '%s captures the agent session after reading its value source',
  async (command) => {
    const value = secretInput().value;
    if (command === 'import')
      await writeFile(resolve(keyring.home, '.env'), `KEY=${value}`);
    const transport = await createTransport(app, () => undefined);
    try {
      await configure(transport.origin);
      const entry = resolve(testBuild, 'cli.js');
      const args = command === 'create' ? createArgs() : importArgs();
      const observeRead =
        command === 'create'
          ? `process.stdin.once('end', () => { process.env.NOOK_AGENT_SESSION = 'after-source'; });`
          : `
        import fs from 'node:fs/promises';
        import { syncBuiltinESMExports } from 'node:module';
        const read = fs.readFile;
        fs.readFile = async (...args) => {
          const bytes = await read(...args);
          if (args[0] === '.env') process.env.NOOK_AGENT_SESSION = 'after-source';
          return bytes;
        };
        syncBuiltinESMExports();
      `;
      const script = `${observeRead}
      process.argv = ${JSON.stringify([process.execPath, entry, ...args])};
      await import(${JSON.stringify(entry)});`;
      const result = await keyring.command(
        process.execPath,
        ['--input-type=module', '-e', script],
        { ...childEnv(), NOOK_AGENT_SESSION: 'before-source' },
        command === 'create' ? value : '',
        keyring.home,
      ).done;
      expect(result.status).toBe(0);
      expectOutput(result.stderr, '', true);
      expectNoValue(result.stdout + result.stderr, [value]);
      expect(transport.bodies).toHaveLength(1);
      const payload = JSON.parse(transport.bodies[0].toString());
      expect(payload.agentSession).toEqual({
        agent: 'declared',
        session: 'after-source',
      });
      expect(payload.workingDirectory).toBe(await realpath(keyring.home));
      expect((await auditRows(app))[0]).toMatchObject({
        agent: 'declared',
        agent_session: 'after-source',
        working_directory: await realpath(keyring.home),
      });
    } finally {
      await transport.close();
    }
  },
);
