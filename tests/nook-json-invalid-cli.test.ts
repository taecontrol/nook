import { randomBytes } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { it } from 'vitest';
import { acmePath } from './support/audit.ts';
import {
  beforeAccess,
  file,
  mappings,
  privateValues,
  runArgs,
  setupNookJsonCli,
} from './support/nook-json-cli.ts';

setupNookJsonCli();
const invalidCases = [
  'malformed JSON',
  'null root',
  'array root',
  'string root',
  'unknown secret key',
  'unknown policy key',
  'missing secrets',
  'null secrets',
  'array secrets',
  'string secrets',
  'invalid environment name',
  'non-string path',
  'invalid path',
  'value-like path',
  'too many paths',
] as const;
function invalidFile(kind: (typeof invalidCases)[number]) {
  const pasted = `ghp_${randomBytes(20).toString('hex')}`;
  privateValues.push(pasted);
  const cases = {
    'malformed JSON': {
      content: `{"secrets":{"GH_TOKEN":"${pasted}",`,
      message: 'malformed JSON.',
    },
    'null root': { content: 'null', message: 'expected an object.' },
    'array root': { content: '[]', message: 'expected an object.' },
    'string root': {
      content: JSON.stringify(pasted),
      message: 'expected an object.',
    },
    'unknown secret key': {
      content: JSON.stringify({ secret: mappings }),
      message: 'unknown key "secret".',
    },
    'unknown policy key': {
      content: JSON.stringify({ secrets: mappings, policy: pasted }),
      message: 'unknown key "policy".',
    },
    'missing secrets': { content: '{}', message: 'secrets must be an object.' },
    'null secrets': {
      content: '{"secrets":null}',
      message: 'secrets must be an object.',
    },
    'array secrets': {
      content: '{"secrets":[]}',
      message: 'secrets must be an object.',
    },
    'string secrets': {
      content: JSON.stringify({ secrets: pasted }),
      message: 'secrets must be an object.',
    },
    'invalid environment name': {
      content: JSON.stringify({ secrets: { '1BAD': acmePath } }),
      message: 'invalid environment name "1BAD".',
    },
    'non-string path': {
      content: '{"secrets":{"GH_TOKEN":123}}',
      message: 'secret path for GH_TOKEN must be a string.',
    },
    'invalid path': {
      content: '{"secrets":{"GH_TOKEN":"work/acme"}}',
      message: 'invalid secret path for GH_TOKEN.',
    },
    'value-like path': {
      content: JSON.stringify({ secrets: { GH_TOKEN: pasted } }),
      message: 'invalid secret path for GH_TOKEN.',
    },
    'too many paths': {
      content: JSON.stringify({
        secrets: Object.fromEntries(
          Array.from({ length: 21 }, (_, i) => [
            `KEY_${i}`,
            `work/acme/KEY_${i}`,
          ]),
        ),
      }),
      message: 'secrets must map at most 20 distinct paths.',
    },
  };
  return cases[kind];
}
// The file is parsed once, before flags, the keyring or the network, so each
// kind runs through `run`; `check` shares the parser and keeps one parse kind
// plus its own mapping limit. One fixture serves every case because each one
// proves it reached no keyring, Worker or audit.
it('E8/E13/E14: run and check reject every invalid file before keyring or network', async () => {
  const cases = [
    ...invalidCases.map((kind) => ({ kind, command: 'run' })),
    { kind: 'array root', command: 'check' },
    { kind: 'too many paths', command: 'check' },
  ] as const;
  for (const { kind, command } of cases) {
    const invalid = invalidFile(kind);
    await writeFile(file, invalid.content);
    await beforeAccess(
      command === 'check' ? ['vault', 'check'] : runArgs(['/usr/bin/true']),
      `Invalid ${file}: ${invalid.message}`,
    ).catch((error: Error) => {
      throw new Error(`${command} with ${kind}: ${error.message}`);
    });
  }
});
