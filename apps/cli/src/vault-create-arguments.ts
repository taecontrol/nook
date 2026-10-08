import {
  splitSecretPath,
  validatePurpose,
  validateSecretDescription,
  validateSecretPath,
} from '@nook/contract';
import { CliFailure } from './errors.ts';

export const createUsage =
  'Usage: nook vault create <bucket>/<NAME> --purpose "…" [--description "…"]';
function createOptions(flags: readonly string[]) {
  if (flags.length % 2) throw new CliFailure(createUsage);
  const options = new Map<string, string>();
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    if (!['--purpose', '--description'].includes(flag) || options.has(flag))
      throw new CliFailure(createUsage);
    options.set(flag, flags[index + 1]);
  }
  return options;
}
export function parseCreate(args: readonly string[]) {
  const [path, ...flags] = args;
  if (!path) throw new CliFailure(createUsage);
  const options = createOptions(flags);
  const purpose = options.get('--purpose');
  if (purpose === undefined) throw new CliFailure('A purpose is required.');
  const description = options.get('--description') ?? '';
  const message =
    validateSecretPath(path) ??
    validatePurpose(purpose) ??
    validateSecretDescription(description);
  if (message) throw new CliFailure(message);
  return { ...splitSecretPath(path), path, purpose, description };
}
