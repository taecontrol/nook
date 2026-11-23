# ADR-0024: Every migration keeps the previous Worker working

Date: 2026-11-23
Status: Accepted

## Context

`pnpm run deploy` applies D1 migrations before it replaces the Worker ([ADR-0023](0023-the-owner-deploys-main-from-a-local-checkout-and-ci-holds-no-cloudflare-credential.md)). Between those two steps the previous Worker keeps serving requests against the migrated schema, and it keeps writing rows that contain only the columns it knows. The owner can also roll the Worker back to an earlier version without rolling back D1, which has no down migrations ([ADR-0007](0007-d1-with-effect-sql-and-hand-written-migrations.md)).

Earlier records met this window case by case. Machine expiry is enforced by D1 so that the previous Worker also rejects expired tokens ([ADR-0020](0020-machine-access-expires-at-an-owner-chosen-date-enforced-in-d1.md)). File attachments accepted a narrower outcome: the previous Worker cannot decode file events, and forgetting a memory that holds files fails without changing files or audit ([ADR-0016](0016-d1-references-decide-file-liveness-and-r2-keys-are-never-reused.md)). No record states the rule these cases apply.

## Decision

A migration keeps the previous Worker's writes valid and its reads correct during the deployment window and after a Worker rollback. A new column accepts rows written without it, through a default, `NULL`, or a trigger. A rule that must hold for every Worker, such as rejecting an expired token, lives in D1 rather than only in the new Worker. Removing or renaming what the previous Worker uses waits for a later migration, once no deployed Worker depends on it.

When a feature cannot meet this, its ADR names what the previous Worker cannot do and shows that it fails without corrupting data, as ADR-0016 does. Tests run the previous Worker's code or writes against the migrated schema.

## Consequences

- A deployment that stops between migrating and replacing the Worker, or a Worker rollback, leaves the installation working, apart from limits an ADR has accepted.
- A schema change that breaks compatibility takes two deployments: one that stops depending on the old shape, and one that removes it.
- Some rules are enforced by D1 triggers and constraints instead of TypeScript, which spreads policy across SQL and code.
- A migration that touches a table the previous Worker reads or writes needs a test with that Worker's code or writes.
