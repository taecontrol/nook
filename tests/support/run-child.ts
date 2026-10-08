import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

const [mode, expected, exit] = process.argv.slice(2);
const hash = (value: string) =>
  createHash('sha256').update(value).digest('hex');
if (mode === 'streams') {
  const report = {
    valueMatches: hash(process.env.GH_TOKEN ?? '') === expected,
    aliasMatches:
      process.env.ALIAS === undefined ||
      process.env.ALIAS === process.env.GH_TOKEN,
    inherited: process.env.NOOK_TEST_INHERITED,
    tokenAbsent: !Object.values(process.env).some((value) =>
      value?.startsWith('nook_'),
    ),
    argvPrivate: !process.argv.some((arg) =>
      arg.includes(process.env.GH_TOKEN ?? 'never-match'),
    ),
    stdin: readFileSync(0, 'utf8'),
  };
  process.stdout.write(JSON.stringify(report) + '\nstdout-one\nstdout-two\n');
  process.stderr.write('stderr-one\nstderr-two\n');
  process.exitCode = Number(exit ?? '0');
} else if (mode === 'tty') {
  process.stdout.write(
    JSON.stringify([
      !!process.stdin.isTTY,
      !!process.stdout.isTTY,
      !!process.stderr.isTTY,
    ]) + '\n',
  );
} else if (mode === 'self-signal') {
  process.kill(process.pid, 'SIGTERM');
} else {
  for (const signal of ['SIGTERM', 'SIGHUP', 'SIGINT'] as const)
    process.on(signal, () => {
      process.stdout.write(signal + '\n');
      process.exit(0);
    });
  process.stdout.write('child-ready\n');
  setInterval(() => {}, 1000);
}
