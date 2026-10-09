import { randomBytes } from 'node:crypto';
import { validateSecretValue } from '@nook/contract';
import { Effect } from 'effect';
import { parseRun } from '../../apps/cli/src/run-arguments.ts';
import { CommandFailure, runCommand } from '../../apps/cli/src/run-command.ts';
import { testEnvironment } from '../../scripts/lib/test-environment.ts';

const home = process.env.HOME;
if (!home)
  throw new Error('The native launch fixture requires a private HOME.');
const mappings = Array.from(
  { length: 128 },
  (_, index) => `LARGE_${index}=work/acme/LARGE`,
);
const parsed = parseRun(
  [
    ...mappings.flatMap((mapping) => ['--secret', mapping]),
    '--purpose',
    'exercise the native environment limit',
    '--',
    '/usr/bin/true',
  ],
  home,
);
const value = randomBytes(48 * 1024).toString('base64');
if (validateSecretValue(value))
  throw new Error('The native launch fixture requires a valid secret value.');
const env = testEnvironment(home);
for (const mapping of parsed.mappings) env[mapping.name] = value;
try {
  process.exitCode = await Effect.runPromise(
    runCommand('/usr/bin/true', parsed.command, env),
  );
} catch (error) {
  if (!(error instanceof CommandFailure))
    throw new Error('The native launch fixture could not report its outcome.');
  process.stdout.write(`${error.message}\n`);
  process.exitCode = error.code;
}
