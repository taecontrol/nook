import type { MemoryClient } from '@nook/contract';

function clientString(value: unknown, limit: number): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= limit &&
    !/[\uD800-\uDFFF]/u.test(value) &&
    !/\p{Cc}/u.test(value)
  );
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object';
}
function envelopeClient(envelope: unknown): MemoryClient | undefined {
  if (!isRecord(envelope)) return;
  const value = envelope['io.modelcontextprotocol/clientInfo'];
  if (!isRecord(value)) return;
  const { name, version } = value;
  if (!clientString(name, 128)) return;
  if (version !== undefined && !clientString(version, 64)) return;
  return { name, version: version === undefined ? null : (version as string) };
}
function userAgentClient(userAgent: string | null): MemoryClient | undefined {
  if (!userAgent || /\p{Cc}/u.test(userAgent)) return;
  const first = userAgent.split(' ')[0];
  const match =
    /^([!#$%&'*+.^_`|~0-9a-z-]+)(?:\/([!#$%&'*+.^_`|~0-9a-z-]+))?$/i.exec(
      first,
    );
  if (!match || !clientString(match[1], 128)) return;
  if (match[2] !== undefined && !clientString(match[2], 64)) return;
  return { name: match[1], version: match[2] ?? null };
}
export function clientFrom(
  envelope: unknown,
  userAgent: string | null,
): MemoryClient {
  return (
    envelopeClient(envelope) ??
    userAgentClient(userAgent) ?? { name: 'unknown', version: null }
  );
}
