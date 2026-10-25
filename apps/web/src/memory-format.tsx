import type { Principal, Provenance as ProvenanceRecord } from '@nook/contract';
import { formatDateTime } from './time';

export function principalName(principal: Principal) {
  return principal.kind === 'owner' ? 'Owner' : principal.name;
}

export function clientName(client: ProvenanceRecord['client']) {
  return `${client.name}${client.version ? ` ${client.version}` : ''}`;
}
export function formatExactBytes(bytes: number): string;
export function formatExactBytes(
  bytes: number,
  output: 'parts',
): readonly string[];
export function formatExactBytes(
  bytes: number,
  output?: 'parts',
): string | readonly string[] {
  // Audit keeps its existing separate count and unit text nodes.
  const parts = [bytes.toLocaleString('en-US'), ' bytes'] as const;
  return output === 'parts' ? parts : parts.join('');
}

const units = ['B', 'KiB', 'MiB'] as const;
export function formatBytes(bytes: number) {
  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const text =
    unit === 0 || Number.isInteger(value)
      ? String(value)
      : value.toFixed(1).replace(/\.0$/, '');
  return `${text} ${units[unit]}`;
}
export function Provenance({
  provenance,
  label = 'Stored',
}: {
  provenance: ProvenanceRecord;
  label?: string;
}) {
  const { client, workingDirectory, at } = provenance;
  return (
    <dl className="mt-5 grid gap-x-7 gap-y-3 border-y py-4 text-xs sm:grid-cols-2">
      <div>
        <dt className="text-muted-foreground">Written by</dt>
        <dd className="mt-0.5 font-medium wrap-anywhere">
          {principalName(provenance.principal)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">
          Client <span>(as reported)</span>
        </dt>
        <dd className="mt-0.5 font-medium wrap-anywhere">
          {clientName(client)}
        </dd>
      </div>
      <div>
        <dt className="text-muted-foreground">{label}</dt>
        <dd>
          <time dateTime={at} className="mt-0.5 block font-medium">
            {formatDateTime(at)}
          </time>
        </dd>
      </div>
      {workingDirectory && (
        <div className="min-w-0">
          <dt className="text-muted-foreground">Working directory</dt>
          <dd
            title={workingDirectory}
            className="mt-0.5 break-all font-mono font-medium"
          >
            {workingDirectory}
          </dd>
        </div>
      )}
    </dl>
  );
}
