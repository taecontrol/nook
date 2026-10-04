# ADR-0008: Delete an empty bucket to correct a mistaken creation

Date: 2026-10-04
Status: Accepted
Supersedes: the similar-name creation feedback sentence in [ADR-0002](0002-buckets-as-the-authorization-boundary.md).

## Context

ADR-0002 proposed reporting similar existing names when creating buckets. During shaping for hierarchical bucket creation, the owner rejected that extra matching policy as more complexity than value. The chosen outline already shows the whole tree and previews the landing position before creation, making duplicates visible.

## Decision

Allow the owner or an authorized agent to delete an empty bucket to correct a mistaken creation. Do not detect similar names, rename, or move buckets. The reserved `me` bucket cannot be deleted.

The rest of ADR-0002's shared hierarchy and authorization boundary remains accepted.

## Consequences

Creation stays deterministic and idempotent without a similarity threshold, suggestions, or a confirmation flow. A mistaken duplicate can be removed while empty.

A bucket with child buckets must keep them until they are removed. Each future tool must include its stored content in the emptiness check before allowing deletion. Correcting a non-empty bucket is deliberately outside this decision.
