import type { Provenance as ProvenanceRecord } from '@nook/contract';
import { formatDateTime } from './time';

export function principalName(memory: { provenance: ProvenanceRecord }) {
  return memory.provenance.principal.kind === 'owner'
    ? 'Owner'
    : memory.provenance.principal.name;
}

export function clientName(client: ProvenanceRecord['client']) {
  return `${client.name}${client.version ? ` ${client.version}` : ''}`;
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
          {principalName({ provenance })}
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
