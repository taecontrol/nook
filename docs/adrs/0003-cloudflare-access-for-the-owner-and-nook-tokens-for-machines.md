# ADR-0003: Cloudflare Access for the owner and Nook-issued tokens for machines

Date: 2026-10-03
Status: Accepted

## Context

The owner uses Nook from a browser, from MCP clients such as Claude Code and Codex, and from the `nook` CLI, across several Linux and macOS machines. Some machines should see only part of the bucket tree ([ADR-0002](0002-buckets-as-the-authorization-boundary.md)).

The Money project already protects a Worker with Cloudflare Access Managed OAuth, so MCP clients complete OAuth without the Worker implementing an authorization server. Access identifies the user, not the machine or client. Running an authorization server with `workers-oauth-provider` plus an upstream identity provider would move OAuth security code into Nook. A CLI also needs an easy login and a safe place to keep its credential.

## Decision

The owner authenticates through Cloudflare Access with Managed OAuth. That covers the browser and trusted MCP clients, with access to the whole tree. The Worker verifies the forwarded Access assertion against the configured owner identity.

Machines with limited access, and the CLI, use **Nook tokens**. `nook login` opens an authorization page protected by Access. There the owner approves the machine and chooses the bucket subtree it may use, or all buckets. Nook stores only a hash of the token and can revoke it from the web app. The CLI keeps the token in the operating system keyring. The same token authenticates MCP clients on limited machines through request headers. The token exchange and token-authenticated requests pass Access through a bypass policy, and Nook validates the token itself.

## Consequences

Nook contains no OAuth server, and the owner's login, MFA, and session policy stay in Access. Per-machine scoping works without creating Access service tokens by hand.

Each installation needs a Zero Trust organization with an Access application and a bypass policy. That is a step in self-hosted setup and a misconfiguration risk: a bypass that is too broad exposes routes that rely only on Access. Nook owns token issuance, hashing, scoping, and revocation, and must test them. Tokens are long-lived until revoked, so the web app has to make the list of machines and their revocation obvious.

## Alternatives considered

- **`workers-oauth-provider` with GitHub as the identity provider:** standard per-client scopes, but more security code to own.
- **Access service tokens per machine:** native to Access, but created by hand outside Nook and awkward for the CLI to obtain.
- **Static bearer tokens without a login flow:** simplest, but they lack owner approval at issuance and leave the user without an obvious place to store the token.
