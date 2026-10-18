# Memory implementation

The [README](../README.md#remember-and-read) describes the caller contract.
[ADR-0012](adrs/0012-memory-retries-use-exact-content-and-request-provenance.md),
[ADR-0013](adrs/0013-search-indexes-derive-from-d1-and-converge-eventually.md),
[ADR-0014](adrs/0014-memory-updates-are-guarded-by-the-read-version-and-recognized-by-current-content.md)
and [ADR-0015](adrs/0015-forgetting-is-version-guarded-and-vector-removal-settles-after-late-writers.md)
record retry identity, provenance, derived indexes, guarded updates and forgetting.
The former storage design brief is retired; these maintained sources, the
contract, migrations and acceptance tests own its decisions.

## Canonical storage

`memories` owns the stable UUID, bucket, current version and current-content
digest. Its internal integer `seq` gives FTS a stable row id and is never
exposed. A head row puts current-content uniqueness in a database constraint
instead of reconstructing the head from the highest version on every read.
Separate immutable `memory_versions` rows retain each version's content,
tags and provenance without repeating the bucket or maintaining an
`is_current` flag on historical rows.

The unique `(bucket, content_hash)` index uses a SHA-256 digest so its keys
do not contain up to 16 KiB of content. Outcome classification still checks
the actual bytes: a digest collision is unavailable, never a duplicate.
The unique guard is a separate index so changing that policy would not
require rebuilding the table. The numbered migrations and `schema.sql`
remain the authoritative schema and independent drift oracle.

Remember, update and forget classify their outcomes from atomic D1 batches.
Guard fragments are shared between writes and their outcome reads; a later
read outside the batch cannot reconstruct the state that committed. Version
insertion precedes publication of the new head, so the FTS triggers replace
immutable postings. History is owner-only. Memory writes add no audit entry.

## Implementation owners

The contract owns schemas, validation, titles and the positive integer version
policy. `memory.ts` owns request operations, their authorization and SQL,
pagination, and index maintenance. `memory-index.ts` owns the AI and Vectorize
protocols and shared marker SQL. `buckets.ts` owns deletion blockers, including
its memory-head check. MCP and HTTP adapters call these owners without
duplicating their policy.

Feed pages use descending creation time and id so updating a memory cannot
move it between pages. A cursor carries that position, bucket and scope with
a versioned checksum. It remains usable after its boundary memory is
forgotten. Checksums detect ordinary alteration; the bucket grant authorizes
each page. Feed and history pages both hold 25 items. History's exclusive
version boundary also accepts cursors issued with the former 26-item page.

See [verification](verification/README.md#memory-remember-and-reader) for the
runtime and privacy evidence, and [deployment](deployment.md#memory-search)
for index repair, backup procedures and hosted acceptance still requiring the
owner's observation. The scheduled bounds are named in `memory-bounds.ts`.
