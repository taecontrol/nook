# ADR-0007: D1 with Effect SQL and hand-written migrations

Date: 2026-10-04
Status: Accepted

## Context

Buckets are the first persisted platform data. Memory and Vault will share their database and authorization boundary. Each installation lives in its owner's Cloudflare account, and the application already uses Effect for its HTTP contract and services.

An integration spike compared the same bucket operations using `@effect/sql-d1`, raw D1, and Drizzle. Effect's D1 adapter added about 8.3 KB gzip to the Worker; Drizzle added about 18.7 KB, had no Effect integration, and its migration check missed an intentionally changed schema. D1 does not support application-managed SQL transactions. Its batches are atomic, which is enough for creating a path and its ancestors together.

## Decision

Use D1 through `@effect/sql-d1` 4.0.0 and maintain SQL migrations by hand. Wrangler owns remote migration application; local verification mirrors its ordered, per-file batches and migration tracking. Keep a committed schema snapshot as an independent drift oracle. Published migrations are immutable, and explicit transactions are forbidden.

This keeps persistence in the existing Effect stack without adding an ORM or a second migration model. Installation-specific database identifiers stay outside source; deployment resolves the database by its configured name.

## Consequences

Database failures remain typed Effect failures, and callers share one persistence mechanism. Atomic batches preserve the bucket hierarchy without unsupported transactions.

The project owns SQL, schema review, and migration verification. The adapter cannot provide transactions or streaming queries. Later changes must preserve data through new migrations rather than editing applied files. Local D1 verifies migration mechanics; remote deployment still requires owner acceptance.

## References

- [D1 migrations](https://developers.cloudflare.com/d1/reference/migrations/)
- [D1 batch atomicity](https://developers.cloudflare.com/d1/worker-api/d1-database/#batch)
