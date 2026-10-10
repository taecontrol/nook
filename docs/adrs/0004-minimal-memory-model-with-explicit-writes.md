# ADR-0004: A minimal memory model with explicit writes

Date: 2026-10-03
Status: Accepted; repository provenance partially superseded by [ADR-0012](0012-memory-retries-use-exact-content-and-request-provenance.md).

## Context

Nook Memory succeeds the owner's Memorable project ([taecontrol/memorable](https://github.com/taecontrol/memorable)). Memorable has typed records (Decision, Observation, Task), entities and relations in a knowledge graph, temporal validity, supersession, and per-record provenance. That structure serves software projects. Nook memory also covers personal areas where those types do not fit, and every structural feature adds schema, validation, and interface work.

The memory systems surveyed on 2026-10-03 split on how they write:

- **Automatic LLM extraction from conversations**, as in Mem0, Supermemory, Graphiti, and Cognee, raises recall. It also widens the surface for memory poisoning, which has been demonstrated in practice: SpAIware against ChatGPT memory ([Rehberger, 2024](https://embracethered.com/blog/posts/2024/chatgpt-macos-app-persistent-data-exfiltration/)) and MINJA through queries alone ([arXiv:2503.03704](https://arxiv.org/abs/2503.03704)).
- **Mem0** dropped automatic UPDATE and DELETE from its open-source extraction, which now only adds ([mem0 `docs/migration/oss-v2-to-v3.mdx` at `abb81c8`](https://github.com/mem0ai/mem0/blob/abb81c8/docs/migration/oss-v2-to-v3.mdx)).
- **Vendor benchmark results** are self-reported and disputed between vendors, so they cannot justify this choice.

## Decision

A memory is Markdown text, one bucket, free-form tags, provenance, and versions. Provenance records which client, machine, and repository wrote it, and when. Editing creates a new version and keeps the earlier ones as history. Forgetting deletes the memory, all its versions, and its search index entries.

Nook has no record types, no entity graph, and no temporal validity. Agents or the owner write memories explicitly. Nook does not extract memories from conversations.

## Consequences

The model fits technical and personal buckets alike, and the interface shows text, history, and provenance without a dynamic schema. Explicit writes keep every memory attributable to a deliberate act, and hard deletion makes forgetting trustworthy.

Recall depends on agents choosing to write, which depends on rules the owner puts in each project. "Everything about X" depends on search and tags, not on graph traversal. Deletion cannot be undone. Adding types, relations, or a review queue for automatic capture later means a schema migration and should be driven by an observed need.

## Alternatives considered

- **Memorable's typed kernel with entities and relations:** rejected until a real query needs it.
- **Automatic capture held in a "proposed" state until the owner approves it:** deferred, not rejected. It becomes reasonable once the review interface exists.
- **Soft deletion:** rejected because forgetting is used when something should not have been stored.
