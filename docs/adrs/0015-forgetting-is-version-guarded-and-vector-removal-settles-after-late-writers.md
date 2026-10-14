# ADR-0015: Forgetting is version-guarded and its vector removal is confirmed after the longest writer plus a propagation margin

Date: 2026-10-14
Status: Accepted

## Context

Forgetting takes back a memory that should no longer be stored. ADR-0004
requires deletion of every version and search entry, with no trash or undo.
ADR-0013 keeps D1 authoritative but lets its derived meaning index lag.
Concurrent updates must not be deleted using an older reading of the memory.

Deleting a canonical row prevents disclosure through Nook, but does not remove
a lingering embedding. An embedding job can finish after deletion, and the
request can die after committing D1. Vectorize mutations are asynchronous,
with no documented maximum propagation delay or ordering guarantee.
The local D1 experiment also found keyword terms in FTS shadow-table blobs
after deletion until compaction; D1 forbids `secure_delete`.

## Decision

Require the version the caller read before forgetting. Delete the memory and
all versions atomically, compacting keyword postings and retaining only the
forgotten id and time for vector cleanup. Authorize against the bucket grant
before validating the version. A successful retry answers not found; another
writer requires a fresh read and a new decision.

Have scheduled cleanup inspect the actual index, delete present forgotten
vectors, and retain the removal record until absence is observed at least
30 minutes after forgetting. Run cleanup independently of embedding repair.
Never depend on a mutation acknowledgement or perform an index call in the
forget request.

The settle window covers the longest possible late writer: current embedding
jobs run in `waitUntil` (up to 30 seconds after a response) or Cron (at most
15 minutes). Another 15 minutes allow propagation, substantially beyond the
observed 30–60 seconds. A shorter settle could acknowledge absence before a
scheduled writer lands. This is a bounded convergence rule, conditional on
successful runs and propagation within that margin.

## Consequences

All Nook reads exclude the memory immediately. Canonical deletion survives
index outages and lost responses; repeated scheduled runs remove late vectors
without touching a newly remembered copy with a different id. Empty buckets
can then be deleted. Each forget pays for global FTS compaction, and cleanup
retains a small non-content record during convergence.

Hosted limits, inspection freshness and propagation still need owner
acceptance. Propagation beyond the margin or a rejection of bounded deletes
requires revisiting this decision. D1 free pages, Time Travel history and
provider storage are outside Nook's erasure guarantee; vector absence proves
only index absence. New long-lived embedding writers must revisit the settle
window before they ship.

## References

- [ADR-0004: Explicit memory writes and hard deletion](0004-minimal-memory-model-with-explicit-writes.md)
- [ADR-0013: Derived search indexes](0013-search-indexes-derive-from-d1-and-converge-eventually.md)
- [ADR-0014: Read-version guards and index inspection](0014-memory-updates-are-guarded-by-the-read-version-and-recognized-by-current-content.md)
- [Workers invocation limits](https://developers.cloudflare.com/workers/platform/limits/)
- [Vectorize client operations](https://developers.cloudflare.com/vectorize/reference/client-api/)
- [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
- [Forget a memory, issue #13](https://github.com/taecontrol/nook/issues/13)
