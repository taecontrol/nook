# ADR-0012: Memory retries use exact content and request provenance

Date: 2026-10-09
Status: Accepted

## Context

Memory writes come from agents. After a lost response, a model can regenerate the same tool call without preserving a client write id. Vault's retry contract in ADR-0011 relies on clients retaining that id, so copying it would leave Memory retries vulnerable to duplicates.

The remote MCP server cannot infer a client's repository or working directory. Observed Claude Code requests carry client information in the request envelope; observed Codex requests carry it only at initialization and identify themselves through User-Agent on subsequent requests. ADR-0009 makes initialization state unavailable across requests. Authentication identifies the principal, but client and directory reports cannot establish identity.

## Decision

Within one bucket, byte-identical current content identifies a repeated `remember` call. Return the existing memory without changing tags or provenance. Give newly stored content a server-generated id, and retain a stable identity and separate versions for future editing. This makes regenerated tool calls safe to retry without client coordination.

Record the authenticated principal and its machine name snapshot. Record the client as reported on each request, preferring the MCP envelope, then the first User-Agent product token, then `unknown`. Record an optional reported absolute working directory rather than a repository field. This supersedes ADR-0004's repository provenance field; its other decisions remain in force.

## Consequences

Concurrent identical writes converge on one memory. A changed byte, including trailing whitespace, creates another memory; identical content in different buckets remains distinct. A retry with different tags preserves the stored tags. Future updates must keep the duplicate guard aligned with current content.

Provenance survives machine revocation and distinguishes authenticated identity from a client claim. A working directory gives the owner useful context without requiring repository discovery or initialization state. It does not prove repository identity. The duplicate guard adds hashing and a uniqueness constraint, while avoiding a retained client write receipt.

## Alternatives considered

- Client write ids: useful for deterministic clients such as the Vault UI and CLI, but do not survive regenerated model calls reliably.
- Normalized content identity: would merge byte differences that the owner chose to preserve.
- A separate repository field: deferred until an observed use requires more than the reported working directory.

## References

- [ADR-0004: Minimal Memory model](0004-minimal-memory-model-with-explicit-writes.md)
- [ADR-0009: Stateless MCP](0009-stateless-mcp-with-the-typescript-sdk.md)
- [ADR-0011: Vault retry identity](0011-vault-writes-are-idempotent-by-client-write-id-and-guarded-by-version.md)
- [Accepted Memory storage design](../design/memory-storage.md)
- [Memory delivery, issue #10](https://github.com/taecontrol/nook/issues/10)
