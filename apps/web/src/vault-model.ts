import type { OwnerSecret } from '@nook/contract';
import { secretLimits, secretLineage } from '@nook/contract';

export {
  secretPath,
  validateSecretName as validateName,
  validateSecretValue as validateValue,
} from '@nook/contract';
export type Secret = OwnerSecret;
export const DESCRIPTION_MAX = secretLimits.description;
export function ancestorsOf(bucket: string) {
  return secretLineage(bucket).slice(1);
}
function byName(a: Secret, b: Secret) {
  return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
}
export function secretsIn(secrets: readonly Secret[], bucket: string) {
  return secrets.filter((secret) => secret.bucket === bucket).sort(byName);
}
export function countByBucket(secrets: readonly Secret[]) {
  const counts = new Map<string, number>();
  for (const secret of secrets)
    counts.set(secret.bucket, (counts.get(secret.bucket) ?? 0) + 1);
  return counts;
}
export function plural(count: number, word: string) {
  return `${count} ${word}${count === 1 ? '' : 's'}`;
}
