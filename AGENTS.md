# Project instructions

## Purpose

Nook is a platform of tools that AI agents use from any machine. It starts
with two tools:

- **Memory:** a general memory that agents read and write over MCP. It is
  organized in buckets, and the owner can browse it in a web UI.
- **Vault:** secrets that agents can use without the owner pasting them into
  a conversation.

Each installation serves one owner and runs in the owner's Cloudflare
account. The first installation is the author's own at `nook.example.com`.
Later, other people should be able to install Nook in their own Cloudflare
accounts. Do not build multi-tenancy.

Prioritize simplicity in architecture and everyday use. Prefer small, clear
solutions.

## Architecture

- One Cloudflare Worker serves `/api/*` and `/mcp`. The static asset layer
  serves the web app shell and hashed assets without running the Worker.
- Use TypeScript and Effect end to end. `HttpApi` definitions in
  `packages/contract` are the single contract for the web app, the CLI, and
  MCP ([ADR-0001](docs/adrs/0001-effect-httpapi-as-the-single-contract.md)).
- Use D1 through `@effect/sql-d1`. Write migrations as plain SQL and apply
  them with `wrangler d1 migrations apply`.
- Buckets and access tokens belong to the platform, and every tool shares
  them ([ADR-0002](docs/adrs/0002-buckets-as-the-authorization-boundary.md),
  [ADR-0003](docs/adrs/0003-cloudflare-access-for-the-owner-and-nook-tokens-for-machines.md)).
- Read the [ADRs](docs/adrs/) before changing an architectural invariant.

## Interface

Build the web app as a single-page app with React, shadcn/ui, TanStack
Router, and TanStack Query. Follow shadcn/ui components and patterns, and
compose screens from them. Do not invent custom visual controls.

The web app must feel instant. Preload routes and data on intent, keep a
query cache, and apply writes optimistically when the outcome is
predictable. Keep the initial JavaScript within the bundle budget.

## Assistant access

Expose each tool to agents as a small set of plain MCP tools whose
descriptions are enough to use them correctly. Projects add their own rules
for when agents use Nook. Do not ship agent instructions for that.

## CLI

The `nook` CLI is TypeScript and Effect, compiled to a single binary for
Linux and macOS, x64 and arm64. It stores its token in the operating system
keyring: Secret Service on Linux, Keychain on macOS. Never store tokens in
files. Release it the way Manuvra does: run a dispatched workflow from a
green `main`, install through mise (`github:taecontrol/nook`), and maintain a
source-only formula in `taecontrol/homebrew-tap`.

## Package management

Use pnpm for dependency installation, package execution, and project scripts.
Before installing a package, verify its latest stable release and install that
version. Do not select beta, RC, canary, or other prerelease direct versions.

## Verification

Every change passes `pnpm verify`, locally and in CI:

- Biome formatting and linting;
- `@shadcn/lint` through Oxlint for the web app;
- type checking;
- a complexity ceiling of 8 per function, checked before coverage;
- a migrations check;
- Vitest for domain, API, MCP, and CLI behavior, with coverage;
- user journeys with the `e2e` runner, whose committed recordings CI replays
  without a model;
- a CRAP score of at most 8 per function;
- a build;
- a budget for the JavaScript that a cold open loads.

Test observable behavior, not implementation details. Local runs and tests
use a synthetic owner and need no Cloudflare account or secret.

## Language

Write project content in English, including code, documentation, UI text,
and agent instructions. Communicate with the owner in Spanish.
