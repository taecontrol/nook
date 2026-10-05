# ADR-0010: Accept Nook tokens only under `/api/machine/*`

Date: 2026-10-04
Status: Accepted

## Context

[ADR-0003](0003-cloudflare-access-for-the-owner-and-nook-tokens-for-machines.md) separates the owner's Access identity from a machine's Nook token. Cloudflare Access applications select hostnames and paths. Its documented policy selectors do not include arbitrary request headers, so Bypass cannot select just Nook Bearers on an otherwise protected route.

Cloudflare documents that the more specific application path wins and that a wildcard after a slash does not cover the parent or a neighboring segment. Managed OAuth authenticates clients at the edge before forwarding requests. Whether it rejects an unrelated Bearer on a protected path, and whether Bypass forwards no `Cf-Access-Jwt-Assertion`, remain production assumptions. Local workerd cannot reproduce that edge behavior.

## Decision

Accept Nook credentials exclusively beneath `/api/machine/*`, now and for future machine operations. One dedicated Access application bypasses this prefix. Under it, Access assertions and the local synthetic owner never authenticate a machine. Authorization creation and device polling are public; identity and revocation require a Nook token.

Keep every owner route outside that prefix, under the whole-hostname Access application. A Nook Bearer never authenticates those routes. `/api/machines` remains an owner path because it does not match `api/machine/*`. Future machine MCP belongs inside the prefix; the existing `/mcp` remains owner-only.

## Consequences

The installation has one explicit Bypass boundary. The Worker owns authentication for every route inside it. Each owner must configure the additional application, preserve whole-hostname protection, and confirm the production assumptions after deployment as described in [deployment.md](../deployment.md).

This first CLI scope issues all-bucket grants but authorizes only identity and revocation. Bucket and MCP access with a Nook token waits for the grant feature; web machine management must precede it. The persisted grant retains the shared grant shape.

## References

- [Access application paths and precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/)
- [Access policies, Bypass, and selectors](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/)
- [Managed OAuth authorization flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#authorization-flow)
