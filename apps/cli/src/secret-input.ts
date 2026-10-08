import { createInterface } from 'node:readline';
import { Writable } from 'node:stream';
import { secretLimits, validateSecretValue } from '@nook/contract';
import { Effect, Redacted } from 'effect';
import { CliFailure } from './errors.ts';

const tooLarge = () => new CliFailure('A value can be at most 64 KiB.');
async function pipedValue() {
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of process.stdin) {
    const bytes = Buffer.from(chunk);
    length += bytes.length;
    if (length > secretLimits.valueBytes + 2) throw tooLarge();
    chunks.push(bytes);
  }
  const value = new TextDecoder('utf-8', {
    fatal: true,
    ignoreBOM: true,
  }).decode(Buffer.concat(chunks));
  return value.replace(/\r?\n$/, '');
}
function hiddenValue(path: string) {
  return new Promise<string>((accept, reject) => {
    // Readline controls the TTY's raw mode; its output sink suppresses all echo.
    const muted = new Writable({
      write(_chunk, _encoding, done) {
        done();
      },
    });
    const prompt = createInterface({
      input: process.stdin,
      output: muted,
      terminal: true,
    });
    let answered = false;
    prompt.once('close', () => {
      if (!answered) reject(new CliFailure('Enter a value.'));
    });
    prompt.once('SIGINT', () => prompt.close());
    process.stdout.write(`Value for ${path}: `);
    prompt.question('', (line) => {
      answered = true;
      prompt.close();
      process.stdout.write('\n');
      accept(line);
    });
  });
}
export function readSecretInput(path: string) {
  return Effect.tryPromise({
    try: async () => {
      const value = process.stdin.isTTY
        ? await hiddenValue(path)
        : await pipedValue();
      const message = validateSecretValue(value);
      if (message) throw new CliFailure(message);
      return Redacted.make(value);
    },
    catch: (error) =>
      error instanceof CliFailure
        ? error
        : new CliFailure('Use valid Unicode for the value.'),
  });
}
