# ADR-0016: D1 references decide file liveness; R2 keys are never reused and are reconciled

Date: 2026-10-22
Status: Accepted

## Context

Memory needs portable files whose bytes stay outside agent conversations.
Files inherit a memory's bucket grant and survive text updates, but forgetting
must make them unavailable immediately. R2 holds bytes while D1 holds memory,
quota and audit facts. The two stores cannot share a transaction: either order
can leave an intermediate state when a request fails or its response is lost.
Concurrent replacements and cleanup must never delete another writer's bytes.

## Decision

Let a D1 reference alone decide whether a file exists. Upload to a fresh R2 key
that will never be reused, then publish its reference, live bucket quota check
and audit event in one D1 batch. Same-digest retries preserve the current file
without writes or audit. Classify every publication from that batch's state;
an ambiguous result retains the object rather than risking a live deletion.

Restrict publication to ten minutes from upload start, using D1's clock in the
batch. Scheduled reconciliation removes only unreferenced objects older than
sixty minutes. The shorter publication window and never-reused keys mean an
object observed as garbage cannot acquire a reference after cleanup decides
to remove it. Inline deletion requires the same committed observation.

Keep file detach guarded by the read digest, and compose file removal and its
audit events into forgetting's existing version-guarded transaction. Restrict
parent deletion while file references remain, so an older Worker fails rather
than silently deleting files without their audit records.

Use the existing audit ledger for file events. A single chronology and cursor
preserve the owner's view across tools; a compatibility trigger supplies bucket
facts for older Vault writers. This adds file events while memory text writes
remain unaudited.

## Consequences

Canonical availability, bucket quota and audit cannot disagree after a commit.
Crashes can leave R2 garbage, but cannot make an unreferenced object downloadable.
Reconciliation repairs missed inline deletions without a staging registry or
reference counter. Orphans occupy storage until the sixty-minute grace plus
one successful sweep walk; quota counts current references only.

The protocol depends on R2 and D1 clocks remaining within the fifty-minute
margin. Hosted acceptance must establish the buffered 25 MiB upload's isolate
headroom. An already-open R2 stream may be interrupted by deletion; downloads
use a fixed-length body and the CLI must verify size and digest before saving.
Provider retention and D1 history remain outside Nook's erasure guarantee.
During rollout, the previous Worker's audit reader cannot decode file events,
and its forget operation fails for memories holding files.

## Alternatives considered

- A D1-first staging registry avoids the clock assumption but introduces
  several persisted states, additional tables and a two-phase deployment.
- Overwriting deterministic keys lets late writers change bytes behind the
  published reference. Content-addressed keys require reference counting and
  can acquire references after a garbage observation.
- A separate file audit table requires merging two chronological keyset scans
  for every page and gives the same history two storage owners.

## References

- [ADR-0001: One contract](0001-effect-httpapi-as-the-single-contract.md)
- [ADR-0002: Bucket authorization](0002-buckets-as-the-authorization-boundary.md)
- [ADR-0015: Guarded forgetting and bounded cleanup](0015-forgetting-is-version-guarded-and-vector-removal-settles-after-late-writers.md)
- [Memory files, issue #67](https://github.com/taecontrol/nook/issues/67)
