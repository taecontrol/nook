# ADR-0011: Vault writes are idempotent by client write id and guarded by version

Date: 2026-10-07
Status: Proposed

## Context

A lost response or D1 failure can leave the owner unsure whether a secret write committed. Retrying must not overwrite a later write. Another owner tab, or an agent that deletes and re-creates a name in a future feature, can change the secret between the initial request and the retry. A failure alone therefore cannot justify saying that nothing was stored.

This contract will also constrain future released CLI writers. The accepted storage design chose a current-state answer over permanent write receipts: receipts would retain historical bookkeeping indefinitely to answer a rare interleaving exactly, while the owner can be told the current state truthfully.

## Decision

Mint one random write id per client submission and use it as the resulting secret's version. A retry whose id is still the current version returns the original success without changing the row, even if its payload differs. A changed submission gets a new id. Require the version the owner saw for replacement and deletion, and reject stale versions instead of silently overwriting another writer.

Treat transport and storage failures as unconfirmed. Retry with the same id; once an attempt is unconfirmed, every later negative answer leaves the submission unconfirmed until a successful metadata list reconciles its version. This includes a missing key: the key can disappear after a committed write loses its response, while listing still works without it. Validation and missing-key failures mean no change only when the submission had no unconfirmed attempt.

## Consequences

One current version provides both retry recognition and protection against stale writers without a receipts table, an append-only history, or another coordination service. Versions belong only in owner metadata; machine discovery does not receive them.

Historical success cannot be recovered after another write has replaced its version. The UI must distinguish pending, unconfirmed, and confirmed writes and use current-state wording for that case. A retried deletion says the secret is no longer stored, rather than claiming who deleted it. Clients must preserve an id across retries and capture the version before asking for destructive confirmation.

## Alternatives considered

- Permanent receipts: exact historical answers, at the cost of an additional durable store and retention policy for every write.
- Last writer wins: simpler request payloads, but a stale tab or retry could destroy a newer secret.

## References

- [ADR-0005: Agent-readable secrets](0005-vault-level-one-injects-agent-readable-secrets.md)
- [ADR-0006: Encryption under a Worker key](0006-vault-values-encrypted-in-d1-under-a-worker-key.md)
- [ADR-0007: D1 and atomic batches](0007-d1-with-effect-sql-and-hand-written-migrations.md)
