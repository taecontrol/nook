# ADR-0006: Vault values encrypted in D1 under a Worker key

Date: 2026-10-03
Status: Accepted

## Context

Nook needs a store for secrets that lives in the owner's Cloudflare account and supports self-hosted installations. Agents and the owner must be able to add secrets at any time, and the Worker must read any of them by name.

As of 2026-10-03:

- **Cloudflare Secrets Store** is in open beta and limited to 100 secrets per account. Each secret reaches a Worker only through its own binding declared in the Worker configuration, so adding a secret requires a redeploy, and there is no runtime lookup by name ([Secrets Store with Workers](https://developers.cloudflare.com/secrets-store/integrations/workers/)).
- **The 1Password JavaScript SDK** does not run on Workers as shipped, because it loads its WebAssembly through the Node file system ([onepassword-sdk-js#184](https://github.com/1Password/onepassword-sdk-js/issues/184)).

## Decision

Store each secret value in D1, encrypted with AES-GCM under a random IV. The key comes from one Worker secret, `VAULT_KEY`, and each row records a key identifier so the key can rotate later. The owner keeps a backup of `VAULT_KEY` outside Cloudflare.

## Consequences

Adding a secret is a database write, with no redeploy and no practical count limit. Values in D1, its backups, and its exports are ciphertext.

Anyone who controls the Worker or its secrets can decrypt everything. Losing `VAULT_KEY` loses every secret. Nook owns the encryption code and future key rotation. D1 Time Travel keeps prior ciphertext for its retention window, so a deleted secret stays recoverable there until that window passes.

## Alternatives considered

- **Secrets Store as the store:** rejected because of the per-secret binding and the limit of 100.
- **1Password as the store:** rejected for now because it does not run on Workers, and the owner wants everything in their Cloudflare account. It remains a candidate as an optional external source.
