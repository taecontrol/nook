# ADR-0001: Effect HttpApi as the single contract for the web app, CLI, and MCP

Date: 2026-10-03
Status: Accepted

## Context

Nook has three clients of the same operations: the web app, the `nook` CLI, and agents over MCP. When each client describes requests and responses separately, the descriptions drift apart, and the CLI and the Worker are the pair most likely to break silently. The owner chose TypeScript with Effect and wanted few dependencies. They also asked for a fast React and shadcn/ui interface, preferably server-rendered. Hono was considered as the HTTP router.

shadcn/ui is React-only, so a server-rendered shadcn/ui interface means React SSR with hydration, which brings a framework router and a Vite server build next to the API router. Following the Money project, the static asset layer can serve the app shell and hashed assets without running the Worker, which leaves the Worker only `/api/*` and `/mcp`. Manuvra, the owner's other CLI, is written in Rust.

## Decision

Define every operation once with Effect `HttpApi` and Effect Schema in a shared contract package. The Worker implements it, and the web app and the CLI use clients derived from it. MCP tools call the same services. Hono is not used, because once the asset layer serves the app it would only route two path prefixes that Effect already handles.

Build the web app as a single-page app (React, shadcn/ui, TanStack Router and Query) served from static assets. It gets its speed from preloading, a query cache, and immutable assets rather than from server rendering.

Write the CLI in TypeScript and Effect as well, compiled to a single binary, so it shares the contract instead of copying it.

## Consequences

A change to an operation is checked by the compiler in the Worker, the web app, and the CLI at once. The stack has a single HTTP model and no server rendering to maintain.

The first paint depends on client JavaScript, so the bundle budget and preloading are responsibilities rather than options. Effect 4 was released on 2026-10-01, so the team takes on early-adopter risk in `HttpApi`, `effect/unstable/*` modules, and `@effect/sql-d1`. The CLI depends on a JavaScript single-binary compiler and does not share Manuvra's Rust release tooling as-is.

## Alternatives considered

- **Hono for HTTP with Effect inside the handlers:** Hono's RPC client would type the web app but not the CLI the same way, which leaves two descriptions of the contract.
- **React SSR through React Router or TanStack Start on Workers:** it adds a second routing system and a server build for an app with one user.
- **A Rust CLI like Manuvra:** it would reuse Manuvra's release pipeline as-is, but the contract would be duplicated by hand across languages.
