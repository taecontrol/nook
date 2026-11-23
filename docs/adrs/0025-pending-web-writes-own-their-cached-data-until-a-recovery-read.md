# ADR-0025: Pending web writes own their cached data until a recovery read

Date: 2026-11-23
Status: Accepted

## Context

The web app applies predictable writes optimistically and caches queries so screens feel instant (AGENTS.md). An optimistic write changes cached data before the server confirms it. While that write is pending, any read of the same data, whether from a refresh, a remount, window focus, or intent preloading, can return a response from before the write and overwrite the optimistic state. The owner would see their change disappear and then return.

Writes also outlive the screen that started them. The owner can navigate away while a write is pending, and the screen they return to must still show that write's progress and outcome.

## Decision

Buckets, Vault, Memory, Machines, and Ask first route their writes and the reads of the data those writes change through one shared write gate. While a write is pending, it owns that cached data: queries are disabled or treated as fresh, preloads are skipped, and explicit refreshes return the cached value. After the write settles, a recovery read reconciles the cache with the server. A write whose outcome the client could not confirm stays marked as unconfirmed until a later read settles it.

These areas track writes in TanStack Query's mutation cache, not in component state, so a pending or settled write survives route unmounts and a remounted screen observes it.

## Consequences

- A stale response cannot overwrite an optimistic change in these areas.
- A new read path for data these areas write must go through the write gate, or it can bring the flicker back.
- While a write is pending, the owner may not see changes made by other clients until the recovery read.
- Code that reads write outcomes depends on TanStack Query's mutation state.
- Screens outside the write gate, such as the owner approval screen, which holds its submission in component state, follow their own rules.
