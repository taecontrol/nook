import {
  splitSecretPath,
  validatePurpose,
  validateSecretDescription,
  validateSecretPath,
} from '@nook/contract';
import { type Grammar, parseArguments } from './arguments.ts';
import { CliFailure } from './errors.ts';

export const createGrammar: Grammar = {
  usage: 'nook vault create <bucket>/<NAME> --purpose "…" [--description "…"]',
  positional: ['path'],
  flags: { purpose: 'required', description: 'optional' },
};
export function parseCreate(args: readonly string[]) {
  const {
    positional: [path],
    flags,
  } = parseArguments(createGrammar, args);
  const [purpose] = flags.get('purpose') ?? [];
  const [description = ''] = flags.get('description') ?? [];
  const message =
    validateSecretPath(path) ??
    validatePurpose(purpose) ??
    validateSecretDescription(description);
  if (message) throw new CliFailure(message);
  return { ...splitSecretPath(path), path, purpose, description };
}
