import { spawn } from 'node:child_process';
import { once } from 'node:events';
import {
  mkdir,
  mkdtemp,
  open,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { resolve } from 'node:path';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
import {
  temporaryTestHome,
  testEnvironment,
} from '../scripts/lib/test-environment.ts';

it('a failed test names itself and its error in the log before its file finishes', async () => {
  const home = await temporaryTestHome();
  const directory = await mkdtemp(resolve('.local', 'failure-report-'));
  const log = resolve(directory, 'output.log');
  try {
    await mkdir(resolve(directory, 'tests'));
    await writeFile(
      resolve(directory, 'tests', 'early.test.ts'),
      `import { readFileSync } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';
import { expect, it } from 'vitest';
it('fails first', () => expect(1).toBe(2));
it('finds that failure in the log while the file runs', () =>
  expect
    .poll(() => stripVTControlCharacters(readFileSync(${JSON.stringify(log)}, 'utf8')))
    .toMatch(/early\\.test\\.ts > fails first\\s+expected 1 to be 2/));
`,
    );
    const output = await open(log, 'w');
    const child = spawn(
      process.execPath,
      [resolve('node_modules/vitest/vitest.mjs'), 'run', '--dir', directory],
      {
        stdio: ['ignore', output.fd, output.fd],
        env: testEnvironment(home, { COVERAGE_RUN: '' }),
      },
    );
    await once(child, 'exit');
    await output.close();
    expect(stripVTControlCharacters(await readFile(log, 'utf8'))).toMatch(
      /Tests\s+1 failed \| 1 passed/,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
    await rm(home, { recursive: true, force: true });
  }
});
