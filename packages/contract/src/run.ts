import { Schema } from 'effect';
import { validateBucketPath } from './buckets.ts';
import { SecretValue, validateSecretName } from './vault.ts';

export function splitSecretPath(path: string) {
  const separator = path.lastIndexOf('/');
  return { bucket: path.slice(0, separator), name: path.slice(separator + 1) };
}
export function validateSecretPath(path: string): string | undefined {
  const { bucket, name } = splitSecretPath(path);
  if (validateBucketPath(bucket) || validateSecretName(name))
    return 'Use a secret path such as work/acme/GH_TOKEN.';
}
export function validatePurpose(purpose: string): string | undefined {
  if (
    !purpose.trim() ||
    /[\r\n\u2028\u2029]/u.test(purpose) ||
    Array.from(purpose).length > 200
  )
    return 'Purpose must be one line of 1 to 200 characters.';
}
const byteLength = (value: string) => new TextEncoder().encode(value).length;
function validDirectory(directory: string) {
  if (
    !directory.startsWith('/') ||
    directory.includes('\0') ||
    byteLength(directory) > 4096
  )
    return 'Working directory must be an absolute path of 1 to 4096 bytes.';
}
function validExecutable(executable: string) {
  if (!executable || /[/\0]/.test(executable) || byteLength(executable) > 255)
    return 'Executable must be a name of 1 to 255 bytes, without a slash or NUL.';
}
function validPaths(paths: readonly string[]) {
  const distinct = [...new Set(paths)];
  if (distinct.length < 1 || distinct.length > 20)
    return 'Request 1 to 20 distinct secret paths.';
  if (distinct.some((path) => validateSecretPath(path)))
    return 'Use a secret path such as work/acme/GH_TOKEN.';
}
export const RunSecrets = Schema.Struct({
  purpose: Schema.String,
  workingDirectory: Schema.String,
  executable: Schema.String,
  secrets: Schema.Array(Schema.String),
});
export type RunSecrets = typeof RunSecrets.Type;
export function validateRunSecrets(input: RunSecrets): string | undefined {
  return (
    validatePurpose(input.purpose) ??
    validDirectory(input.workingDirectory) ??
    validExecutable(input.executable) ??
    validPaths(input.secrets)
  );
}
export const DeliveredSecrets = Schema.Struct({
  values: Schema.Array(
    Schema.Struct({ path: Schema.String, value: SecretValue }),
  ),
});
export class InvalidRun extends Schema.Error<InvalidRun>('nook/InvalidRun')(
  { _tag: Schema.tag('InvalidRun'), message: Schema.String },
  { httpApiStatus: 400 },
) {}
export class SecretsForbidden extends Schema.Error<SecretsForbidden>(
  'nook/SecretsForbidden',
)(
  { _tag: Schema.tag('SecretsForbidden'), paths: Schema.Array(Schema.String) },
  { httpApiStatus: 403 },
) {}
export class SecretKeyUnavailable extends Schema.Error<SecretKeyUnavailable>(
  'nook/SecretKeyUnavailable',
)(
  { _tag: Schema.tag('SecretKeyUnavailable'), message: Schema.String },
  { httpApiStatus: 503 },
) {}
