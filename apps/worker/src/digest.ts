export async function sha256(content: string | Uint8Array) {
  const bytes = await crypto.subtle.digest(
    'SHA-256',
    (typeof content === 'string'
      ? new TextEncoder().encode(content)
      : content) as Uint8Array<ArrayBuffer>,
  );
  return Array.from(new Uint8Array(bytes), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
