# ADR-0014: Memory updates are guarded by the read version and recognized by current content

Date: 2026-10-13
Status: Accepted

## Context

An agent must replace a changed fact without leaving the stale fact current.
Concurrent agents and regenerated calls after a lost response must preserve
each other's work. The owner needs immutable versions with independent
provenance, while agents read only the current version. ADR-0012 identifies
repeated creation by exact current content; ADR-0013 keeps D1 authoritative
and promises that its derived search indexes converge.

A vector job can finish after a newer job, or die between its external write
and its acknowledgement. A current acknowledgement in D1 therefore cannot
prove that the actual vector still represents current content. Filtering
stale search hits prevents disclosure but cannot repair missing recall when
no search occurs.

## Decision

Require the version read by the agent for an update. Append an immutable
version when it still matches, preserving the memory's identity, bucket and
original creation time. Reject stale changes. Recognize an already applied
request by byte-identical current content and equal resulting tag arrays,
including their order, even when the supplied version is stale. Omitted tags
keep the current tags; an empty array clears them. Reject another memory's
identical current content in the same bucket and name that memory.

Keep the existing schema. D1 atomically appends the version before publishing
it, allowing the existing keyword triggers to replace immutable postings.
Shared SQL guards govern both publication and its outcome read; authorization
remains in the platform grant policy.

Supplement embedding acknowledgements with bounded, rotating inspection of
the actual index. Missing or inconsistent vectors invalidate their marker
for later repair, independently of search. Allow recent updates to settle
before inspection, and defer inspection of vectors repaired in that run.

## Consequences

Retries need no client write id or retained receipt. An answer describes the
current state: another writer can make a retry stale even after the first
attempt committed, and restoring identical content and tags can make a stale
retry a no-op. History remains owner-only, so updates are destructive from an
agent's view.

Updates cost two database round trips without a migration or deploy-time
schema skew. Meaning recall remains eventual; inspection adds bounded index
reads and a sweep takes about one scheduled run per fifty settled memories.
Convergence depends on successful scheduled runs and eventual index
propagation. Hosted inspection metadata and freshness require owner
acceptance after deployment.

## References

- [ADR-0012: Memory retry identity and provenance](0012-memory-retries-use-exact-content-and-request-provenance.md)
- [ADR-0013: Derived search indexes](0013-search-indexes-derive-from-d1-and-converge-eventually.md)
- [Update and history, issue #12](https://github.com/taecontrol/nook/issues/12)
