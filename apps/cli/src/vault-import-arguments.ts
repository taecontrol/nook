import { validateBucketPath, validatePurpose } from '@nook/contract';
import { type Grammar, parseArguments } from './arguments.ts';
import { CliFailure } from './errors.ts';

export const importGrammar: Grammar = {
  usage: 'nook vault import <bucket> <file> --purpose "…"',
  positional: ['bucket', 'file'],
  flags: { purpose: 'required' },
};
export function parseImport(args: readonly string[]) {
  const {
    positional: [bucket, file],
    flags,
  } = parseArguments(importGrammar, args);
  const [purpose] = flags.get('purpose') ?? [];
  const message = validateBucketPath(bucket) ?? validatePurpose(purpose);
  if (message) throw new CliFailure(message);
  return { bucket, file, purpose };
}
