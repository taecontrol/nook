# ADR-0018: Machine access can expire at an owner-chosen date, enforced in D1

Date: 2026-11-02
Status: Accepted

## Context

Machine tokens previously lasted until revoked ([ADR-0003](0003-cloudflare-access-for-the-owner-and-nook-tokens-for-machines.md)). A forgotten sandbox could retain standing access. The owner chose a fixed lifetime at approval, with No expiration available and existing approvals preserved.

Deploy applies migrations before replacing the Worker. The previous Worker also has to reject expired tokens during that window and after a rollback. Released CLIs decode machine authentication failures as `Unauthorized`; changing the tag would turn expiry into a network error and prevent logout from clearing the keyring.

## Decision

Store a nullable absolute access expiry, anchored at approval on D1's clock. NULL means never. Authentication already updates last use and requires a returned row. A D1 trigger scoped to updates of last use ignores expired rows, including equality with D1's current time. It is the sole enforcement of expiry, so every Worker version rejects expired tokens through the same authentication operation. Owner access edits and deletion remain possible.

Keep the `Unauthorized` tag and 401 status, adding only an optional `expiredAt` for the new CLI's recovery message. Unknown and revoked tokens keep their exact previous body. Identity's expiry is optional on the wire so a new CLI also works against an older Worker; polling retains its previous success shape. An approval without a lifetime preserves the old page's promise of no expiration.

A local workerd D1 experiment confirmed ignored updates return no rows, including through batches. Acceptance tests exercise the Effect SQL adapter, previous Worker and delivery-base CLI. Remote D1 support is confirmed when deployment applies the migration; a rejected trigger stops deployment before the new Worker is installed.

## Consequences

Expiry survives a Worker rollback and does not update last use or write an audit entry. The trigger is part of the authentication boundary: dropping it would revive expired credentials. Browser and CLI clocks only affect presentation.

Expiry cannot be extended; a machine must log in again. Expired rows remain until the owner removes them. Existing machines and approvals handled by an older Worker have no expiration. Logins in flight during rollback can lose their chosen expiry when the older Worker polls, and a newer tab approving against it also receives no expiration. Each login request lasts at most ten minutes; the owner can see No expiration and revoke those tokens.

## Alternatives considered

- A Worker date predicate would revive expired tokens on rollback. Adding it alongside the trigger would give one rule two owners without an additional guarantee.
- Aborting the update would produce a storage failure in older Workers instead of an authentication failure, breaking logout recovery.
- Rejecting every update would also freeze owner edits and future data maintenance.
- Computing expiry at poll would start the lifetime up to ten minutes after approval.
