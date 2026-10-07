import { VaultNotConfigured } from '@nook/contract';
import { Effect, Redacted } from 'effect';
import { HttpApiError } from 'effect/http-api';

export type Envelope = { key_id: string; iv: string; ciphertext: string };
type Keyring = { keyId: string; key: CryptoKey };
function notConfigured() {
  return new VaultNotConfigured({
    message:
      'This installation has no VAULT_KEY. Add it as a Worker secret, then try again.',
  });
}
function rawKey(binding: string) {
  const trimmed = binding.trim();
  if (!/^[A-Za-z0-9+/]{43}=$/.test(trimmed)) throw notConfigured();
  const bytes = Uint8Array.from(atob(trimmed), (character) =>
    character.charCodeAt(0),
  );
  if (bytes.length !== 32 || btoa(String.fromCharCode(...bytes)) !== trimmed)
    throw notConfigured();
  return bytes;
}
let cached: { binding: string; ring: Promise<Keyring> } | undefined;
export function parseKeyring(binding = '') {
  return Effect.tryPromise({
    try: () => {
      if (cached?.binding === binding) return cached.ring;
      const bytes = rawKey(binding);
      const ring = Promise.all([
        crypto.subtle.importKey('raw', bytes, 'AES-GCM', false, [
          'encrypt',
          'decrypt',
        ]),
        crypto.subtle.digest('SHA-256', bytes),
      ]).then(([key, fingerprint]) => ({
        key,
        keyId: Array.from(new Uint8Array(fingerprint), (byte) =>
          byte.toString(16).padStart(2, '0'),
        )
          .join('')
          .slice(0, 16),
      }));
      cached = { binding, ring };
      return ring;
    },
    catch: notConfigured,
  });
}
function encode(bytes: ArrayBuffer | Uint8Array) {
  return btoa(
    Array.from(new Uint8Array(bytes), (byte) => String.fromCharCode(byte)).join(
      '',
    ),
  )
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replaceAll('=', '');
}
function decode(text: string) {
  return Uint8Array.from(
    atob(text.replaceAll('-', '+').replaceAll('_', '/')),
    (character) => character.charCodeAt(0),
  );
}
export function seal(
  ring: Keyring,
  path: string,
  value: Redacted.Redacted<string>,
) {
  return Effect.tryPromise({
    try: async () => {
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const ciphertext = await crypto.subtle.encrypt(
        {
          name: 'AES-GCM',
          iv,
          additionalData: new TextEncoder().encode(path),
          tagLength: 128,
        },
        ring.key,
        new TextEncoder().encode(Redacted.value(value)),
      );
      return {
        key_id: ring.keyId,
        iv: encode(iv),
        ciphertext: encode(ciphertext),
      };
    },
    catch: () => new HttpApiError.ServiceUnavailable(),
  });
}
export function open(ring: Keyring, path: string, envelope: Envelope) {
  return Effect.tryPromise({
    try: async () => {
      if (envelope.key_id !== ring.keyId) throw new Error('Unknown key');
      const bytes = await crypto.subtle.decrypt(
        {
          name: 'AES-GCM',
          iv: decode(envelope.iv),
          additionalData: new TextEncoder().encode(path),
          tagLength: 128,
        },
        ring.key,
        decode(envelope.ciphertext),
      );
      return Redacted.make(
        new TextDecoder('utf-8', { fatal: true }).decode(bytes),
      );
    },
    catch: () => new HttpApiError.ServiceUnavailable(),
  });
}
