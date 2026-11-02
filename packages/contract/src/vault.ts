import { Schema } from 'effect';

export const secretLimits = {
  name: 64,
  description: 200,
  valueBytes: 64 * 1024,
} as const;
export const secretValueLimit = `${secretLimits.valueBytes / 1024} KiB`;
export const secretValueLimitMessage = `A value can be at most ${secretValueLimit}.`;
export function secretValueTooLong(value: string) {
  return new TextEncoder().encode(value).length > secretLimits.valueBytes;
}
export function validateSecretName(name: string): string | undefined {
  if (name === '') return 'Enter a name.';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    return 'Use uppercase letters, digits, and underscores, starting with a letter or underscore.';
  if (name.length > secretLimits.name)
    return `A name can have at most ${secretLimits.name} characters.`;
}
export function validateSecretDescription(
  description: string,
): string | undefined {
  if (/[\r\n\u2028\u2029]/u.test(description))
    return 'Use one line for the description.';
  if (Array.from(description).length > secretLimits.description)
    return `A description can have at most ${secretLimits.description} characters.`;
}
export type SecretValueIssue = 'empty' | 'nul' | 'unicode' | 'too-long';
export function secretValueIssue(value: string): SecretValueIssue | undefined {
  if (value === '') return 'empty';
  if (value.includes('\0')) return 'nul';
  if (/[\uD800-\uDFFF]/u.test(value)) return 'unicode';
  if (secretValueTooLong(value)) return 'too-long';
}
export function validateSecretValue(value: string): string | undefined {
  const issue = secretValueIssue(value);
  if (issue === undefined) return;
  return {
    empty: 'Enter a value.',
    nul: 'A value cannot contain NUL.',
    unicode: 'Use valid Unicode for the value.',
    'too-long': secretValueLimitMessage,
  }[issue];
}
export function secretPath(secret: { bucket: string; name: string }) {
  return `${secret.bucket}/${secret.name}`;
}
export const WriteId = Schema.String.check(Schema.isUUID(4));
export const Secret = Schema.Struct({
  path: Schema.String,
  bucket: Schema.String,
  name: Schema.String,
  description: Schema.String,
  updatedAt: Schema.String,
});
export type Secret = typeof Secret.Type;
export const OwnerSecret = Secret.mapFields((fields) => ({
  ...fields,
  version: WriteId,
}));
export type OwnerSecret = typeof OwnerSecret.Type;
export const SecretValue = Schema.RedactedFromValue(Schema.String);
export const CreateSecret = Schema.Struct({
  bucket: Schema.String,
  name: Schema.String,
  description: Schema.optionalKey(Schema.String),
  value: SecretValue,
  writeId: WriteId,
});
export type CreateSecret = typeof CreateSecret.Type;
export const ReplaceSecret = Schema.Struct({
  description: Schema.optionalKey(Schema.String),
  value: SecretValue,
  writeId: WriteId,
  expectedVersion: WriteId,
});
export type ReplaceSecret = typeof ReplaceSecret.Type;
export class InvalidSecret extends Schema.Error<InvalidSecret>(
  'nook/InvalidSecret',
)(
  { _tag: Schema.tag('InvalidSecret'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class SecretExists extends Schema.Error<SecretExists>(
  'nook/SecretExists',
)(
  { _tag: Schema.tag('SecretExists'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class SecretChanged extends Schema.Error<SecretChanged>(
  'nook/SecretChanged',
)(
  { _tag: Schema.tag('SecretChanged'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class SecretNotFound extends Schema.Error<SecretNotFound>(
  'nook/SecretNotFound',
)(
  { _tag: Schema.tag('SecretNotFound'), message: Schema.String },
  { httpApiStatus: 404 },
) {}
export class BucketHasSecrets extends Schema.Error<BucketHasSecrets>(
  'nook/BucketHasSecrets',
)(
  { _tag: Schema.tag('BucketHasSecrets'), message: Schema.String },
  { httpApiStatus: 409 },
) {}
export class VaultNotConfigured extends Schema.Error<VaultNotConfigured>(
  'nook/VaultNotConfigured',
)(
  { _tag: Schema.tag('VaultNotConfigured'), message: Schema.String },
  { httpApiStatus: 503 },
) {}
