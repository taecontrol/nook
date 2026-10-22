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
immutable postings. History is owner-only. Memory text writes add no audit
entry. File operations add events to the shared Audit ledger, as recorded in
[ADR-0016](adrs/0016-d1-references-decide-file-liveness-and-r2-keys-are-never-reused.md).

## Implementation owners

The contract owns schemas, validation, titles and the positive integer version
policy. `memory.ts` owns request operations, their authorization and SQL,
and pagination. `memory-sync.ts` owns post-write embedding, scheduled repair,
forgotten-vector removal and rotating inspection, including their SQL and
failure isolation. Requests schedule embedding only after a successful write;
the Cron handler calls sync directly. `memory-index.ts` owns the AI and
Vectorize protocols and shared marker SQL. `buckets.ts` owns deletion blockers,
including its memory-head check. MCP and HTTP adapters call these owners
without duplicating their policy.

`memory-files.ts` owns attaching, detaching and downloading current files,
including the publication batch, live quota and guarded audit events.
`file-objects.ts` alone accesses the R2 binding. `file-sweep.ts` reconciles
unreferenced objects independently of memory-index repair on each Cron run.
Shared `bucketFor` authorization lives in `memory-access.ts`: unreadable ids
remain not found, readable ancestors cannot be written, and downloads use the
read grant. Forget embeds the file statements in its existing atomic batch,
then removes the keys returned by the committed deletion.

Files belong to the memory, not to a version, and attaching does not update
the text head's version or dates. D1 alone decides existence and current byte
usage within the memory's direct bucket. Detail and MCP search projections
stay inside their existing SQL calls; the owner feed and version history do
not carry files. MCP exposes metadata and guarded detach, never bytes. File
downloads are audited before streaming and carry attachment-only, no-store,
nosniff and sandbox headers. See [deployment](deployment.md) for R2 provisioning,
the reconciliation grace and the hosted acceptance risks.

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
