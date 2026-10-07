import { createHash, randomBytes, randomUUID, webcrypto } from 'node:crypto';
import { Effect, Redacted } from 'effect';
import { expect, it } from 'vitest';
import { open, parseKeyring, seal } from '../apps/worker/src/vault-keyring.ts';

it('the keyring imports a non-extractable AES-256 key and fingerprints raw bytes', async () => {
  const key = randomBytes(32);
  const binding = ` \n${key.toString('base64')}\n `;
  const ring = await Effect.runPromise(parseKeyring(binding));
  expect(ring.key.extractable).toBe(false);
  expect(ring.key.algorithm).toEqual({ name: 'AES-GCM', length: 256 });
  expect(ring.keyId).toBe(
    createHash('sha256').update(key).digest('hex').slice(0, 16),
  );
  expect(
    (await Effect.runPromise(parseKeyring(binding))).key === ring.key,
  ).toBe(true);
});
it('keyring seal and open use the full path as AAD and preserve exact UTF-8', async () => {
  const key = randomBytes(32);
  const ring = await Effect.runPromise(parseKeyring(key.toString('base64')));
  const value = `synthetic-${randomUUID()}\né🙂 \n `;
  const path = 'work/acme/MULTILINE_KEY';
  const envelope = await Effect.runPromise(
    seal(ring, path, Redacted.make(value)),
  );
  const oracleKey = await webcrypto.subtle.importKey(
    'raw',
    key,
    'AES-GCM',
    false,
    ['decrypt'],
  );
  const bytes = await webcrypto.subtle.decrypt(
    {
      name: 'AES-GCM',
      iv: Buffer.from(envelope.iv, 'base64url'),
      additionalData: Buffer.from(path),
      tagLength: 128,
    },
    oracleKey,
    Buffer.from(envelope.ciphertext, 'base64url'),
  );
  expect(
    new TextDecoder().decode(bytes) === value,
    'Independent AES-GCM decryption preserves the value',
  ).toBe(true);
  const opened = await Effect.runPromise(open(ring, path, envelope));
  expect(
    Redacted.value(opened) === value,
    'Opening returns the exact value in a Redacted wrapper',
  ).toBe(true);
  expect(JSON.stringify(opened).includes(value)).toBe(false);
  for (const [otherPath, changed] of [
    ['work/globex/MULTILINE_KEY', envelope],
    [path, { ...envelope, key_id: '0000000000000000' }],
    [path, { ...envelope, ciphertext: '@@' }],
    [path, { ...envelope, iv: '@@' }],
  ] as const) {
    const result = await Effect.runPromise(
      Effect.result(open(ring, otherPath, changed)),
    );
    expect(result._tag).toBe('Failure');
    if (result._tag === 'Failure')
      expect(result.failure._tag).toBe('ServiceUnavailable');
    expect(JSON.stringify(result).includes(value)).toBe(false);
  }
});
it('an encryption failure has a fixed typed error with no value-derived details', async () => {
  const ring = await Effect.runPromise(
    parseKeyring(randomBytes(32).toString('base64')),
  );
  const key = await crypto.subtle.importKey(
    'raw',
    randomBytes(32),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const value = `synthetic-${randomUUID()}`;
  const result = await Effect.runPromise(
    Effect.result(seal({ ...ring, key }, 'me/KEY', Redacted.make(value))),
  );
  expect(result._tag).toBe('Failure');
  if (result._tag === 'Failure')
    expect(result.failure._tag).toBe('ServiceUnavailable');
  expect(JSON.stringify(result).includes(value)).toBe(false);
});
