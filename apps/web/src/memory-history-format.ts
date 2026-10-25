import type {
  MemoryVersion,
  Provenance as ProvenanceRecord,
} from '@nook/contract';
import { clientName, principalName } from './memory-format';

export function principalLabel(memory: { provenance: ProvenanceRecord }) {
  return `${principalName(memory.provenance.principal)} · ${clientName(memory.provenance.client)}`;
}

export function tagChanges(
  before: readonly string[],
  after: readonly string[],
) {
  return {
    added: after.filter((tag) => !before.includes(tag)),
    removed: before.filter((tag) => !after.includes(tag)),
  };
}

/** What this version changed, derived from the version before it. */
export function changeSummary(
  version: MemoryVersion,
  previous?: MemoryVersion,
) {
  if (!previous) return 'First version';
  const content = version.content !== previous.content;
  const { added, removed } = tagChanges(previous.tags, version.tags);
  const tags = [...added.map((t) => `+${t}`), ...removed.map((t) => `−${t}`)];
  if (!content && !tags.length) return 'Tags only: reordered';
  if (!content) return `Tags only: ${tags.join(' ')}`;
  return tags.length ? `Content · tags ${tags.join(' ')}` : 'Content';
}
