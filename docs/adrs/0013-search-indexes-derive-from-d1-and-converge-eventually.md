# ADR-0013: Search indexes derive from D1 and converge eventually

Date: 2026-10-10
Status: Accepted

## Context

Agents need to find Spanish and English memories using both exact words and meaning. Keyword matching cannot find equivalent wording across languages. The accepted embedding experiment found useful cross-language results, but the hosted vector index took roughly 30–60 seconds to expose writes and sometimes returned incomplete filtered results after reporting a mutation processed. A synchronous vector write cannot make search immediately complete.

Bucket grants and current memory content already belong to D1. Moving those decisions into a second service would make access and freshness depend on a derived index that can lag or fail. Blocking memory writes on that service would also make storing a memory less reliable.

## Decision

Keep D1 authoritative for memory content, current versions, and visibility. Treat keyword and meaning indexes as rebuildable derivatives. Re-read every vector candidate against the caller's visible bucket paths and current content hash in D1; metadata filtering reduces work but never authorizes a result.

Update keyword search within the memory transaction. Write embeddings after a successful new memory write and repair pending or outdated embeddings periodically. Remembering a memory succeeds independently of embedding availability. Search falls back to keyword results with an explicit incomplete-results notice when meaning search fails.

## Consequences

Exact words are searchable immediately; meaning becomes searchable eventually. A persisted marker identifies the model and content successfully written, rather than promising visibility in the hosted index. Model changes and lost writes can converge without a manual reindex command. Stale or orphaned vector candidates cannot expose old or unauthorized content.

Readers can see fewer meaning results during propagation or outages. Index repair consumes embedding capacity, and rebuilding after a restore requires access to the canonical memory data. Version rows must remain immutable for the external-content keyword index; future update and forget operations must maintain both derivatives while preserving D1's authority.

## References

- [ADR-0002: Buckets as the authorization boundary](0002-buckets-as-the-authorization-boundary.md)
- [ADR-0004: Minimal Memory model](0004-minimal-memory-model-with-explicit-writes.md)
- [Memory search, issue #11](https://github.com/taecontrol/nook/issues/11)
