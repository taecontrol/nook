import type { Provenance } from '@nook/contract';

export function principalName(memory: { provenance: Provenance }) {
  return memory.provenance.principal.kind === 'owner'
    ? 'Owner'
    : memory.provenance.principal.name;
}
