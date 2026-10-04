# ADR-0002: Hierarchical buckets as the authorization boundary for every tool

Date: 2026-10-03
Status: Accepted (similar-name creation feedback superseded by [ADR-0008](0008-delete-empty-buckets-to-correct-mistakes.md))

## Context

The owner wants to keep memory and secrets for separate areas of life apart: work, a specific project, personal. A work machine should be able to see work material without seeing personal material.

In the agent-memory systems surveyed on 2026-10-03, a "bucket" is almost always a scope identifier sent by the caller on a shared store, for example Mem0 `user_id`, Supermemory `containerTag`, Graphiti `group_id`, or Memorable `space`. It works as a query filter, not an authorization boundary. Mem0's self-hosted server lets any authenticated key read and delete memories for any `user_id` ([mem0 `server/main.py` L367–548 at `abb81c8`](https://github.com/mem0ai/mem0/blob/abb81c8/server/main.py#L367-L548)). None of those systems documents per-client, per-bucket permissions.

The MCP specification revision 2026-07-28 removes sessions and deprecates Roots. It recommends passing directories "via tool parameters, resource URIs, or server configuration" ([MCP changelog](https://modelcontextprotocol.io/specification/2026-07-28/changelog)). A remote server therefore cannot infer which project a client is working in.

## Decision

Buckets are a platform concept that every Nook tool shares. They form a path hierarchy such as `me`, `work`, `work/acme`, and `personal/finances`. Each record or secret belongs to exactly one bucket. Reading from a bucket also includes its ancestors, never its siblings or descendants. For example, `work/acme` sees `work` and `me` but not `personal`.

Every access is authorized against the subtree that the caller's token grants. A grant can cover the whole tree. Agents name the bucket explicitly on every call. When they do not know it, they ask the owner. Agents may create a bucket after asking the owner. Creation reports similar existing names to limit duplicates.

Isolation is logical: one database with a bucket column, enforced on every operation. It is not one physical store per bucket.

## Consequences

One permission model and one bucket tree cover memory, secrets, and future tools. Revoking or narrowing a machine applies everywhere. Ancestor reads support preferences shared by everything and work context shared by all work.

Because isolation is logical, a missing authorization check exposes other buckets. Every operation needs a test proving that it denies paths outside the grant. A record cannot live in two buckets. If cross-cutting material appears, it has to move to a common ancestor. Agents have to know or ask for the bucket, which costs a turn the first time in a project. That an agent asks before creating a bucket is an instruction, not something Nook can enforce.

## Alternatives considered

- **Tags as filters:** they are simple and flexible, but they cannot serve as a security boundary.
- **One Durable Object or database per bucket:** it isolates physically, but ancestor reads and grants over all buckets turn every query into a fan-out and merge.
- **A per-project default bucket in the MCP URL:** the owner preferred an explicit bucket on every call, with the agent asking when it does not know.
