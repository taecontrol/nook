# ADR-0009: Stateless MCP with the TypeScript SDK

Date: 2026-10-04
Status: Accepted

## Context

Claude Code 2.1.289 uses MCP 2026-07-28, while Codex 0.160.0 initializes with 2025-06-18. Worker isolates do not share memory. An integration spike against workerd showed that Effect 4.0.0's older-protocol adapters require an in-memory session: a fresh server cannot continue Codex's requests. Its modern, stateless adapter alone cannot serve that client.

The official TypeScript SDK 2.3.0 served both observed client sequences with a fresh server per request. Cloudflare's `agents` wrapper pins an older SDK and adds a dependency without improving this boundary.

## Decision

Serve remote MCP through `createMcpHandler` from `@modelcontextprotocol/server` 2.3.0, creating a fresh `McpServer` per request with its stateless legacy fallback. Keep schemas and bucket operations in Effect, using Standard Schema and Standard JSON Schema to declare the tools. MCP uses the same authenticated principal and bucket grants as the API, as required by ADR-0001 and ADR-0002.

## Consequences

Both client protocol revisions work across fresh isolates, without session storage or a GET stream. Nook owns a small SDK adapter alongside Effect's HTTP API; it also owns Origin validation because this serving entry does not provide it. Zod remains a transitive SDK dependency.

Reconsider Effect's native MCP server when Codex supports the stateless revision. Any replacement must preserve the client compatibility and authorization proven by the transport and grant tests.

## References

- [TypeScript SDK 2.3.0 HTTP serving](https://github.com/modelcontextprotocol/typescript-sdk/blob/v2.3.0/docs/serving/http.md)
- [Shared Effect contract](0001-effect-httpapi-as-the-single-contract.md)
- [Bucket authorization boundary](0002-buckets-as-the-authorization-boundary.md)
