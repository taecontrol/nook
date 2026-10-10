import { Schema } from 'effect';
import { readLineage } from './buckets.ts';

export const secretLimits = {
  name: 64,
  description: 200,
  valueBytes: 64 * 1024,
} as const;
export function validateSecretName(name: string): string | undefined {
  if (name === '') return 'Enter a name.';
  if (!/^[A-Z_][A-Z0-9_]*$/.test(name))
    return 'Use uppercase letters, digits, and underscores, starting with a letter or underscore.';
  if (name.length > secretLimits.name)
    return 'A name can have at most 64 characters.';
}
export function validateSecretDescription(
  description: string,
): string | undefined {
  if (/[\r\n\u2028\u2029]/u.test(description))
    return 'Use one line for the description.';
  if (Array.from(description).length > secretLimits.description)
    return 'A description can have at most 200 characters.';
}
export function validateSecretValue(value: string): string | undefined {
  if (value === '') return 'Enter a value.';
  if (value.includes('\0')) return 'A value cannot contain NUL.';
  if (/[\uD800-\uDFFF]/u.test(value)) return 'Use valid Unicode for the value.';
  if (new TextEncoder().encode(value).length > secretLimits.valueBytes)
    return 'A value can be at most 64 KiB.';
}
export function secretPath(secret: { bucket: string; name: string }) {
  return `${secret.bucket}/${secret.name}`;
}
export function secretLineage(bucket: string) {
  return readLineage(bucket);
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
