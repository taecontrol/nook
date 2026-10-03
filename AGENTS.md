# Project instructions

## Purpose

Nook is a platform of tools that AI agents use from any machine. It starts
with Memory and Vault, and more tools will follow. Platform concepts
(buckets, tokens, and authentication) stay shared rather than owned by one
tool.

Each installation serves one owner in their own Cloudflare account, and
anyone should be able to install Nook. Do not build multi-tenancy. Keep
installation-specific values, such as account, hostname, and database IDs,
in configuration, never in code.

## How to decide

- Prefer what makes everyday life simpler, for the owner and in the code.
  Do not copy a pattern from another project only because it exists there.
  Reuse it when it is the simpler choice.
- Use one stack for every tool: TypeScript and Effect. Introduce another
  language or framework only for a concrete reason, recorded in an ADR.
- Read the [ADRs](docs/adrs/) before changing an architectural invariant.
  A changed decision gets a new ADR.

## Obligations on every change

- Secret values never enter a model's context. No MCP tool, error, log line,
  or audit entry returns or records a value. Agents receive values only in
  the environment of a command started by `nook run`.
- Every operation is authorized against the caller's bucket grant and has a
  test proving that it denies a path outside the grant.
- The web app must feel instant. Preload routes and data on intent, cache
  queries, apply predictable writes optimistically, and stay within the
  bundle budget.
- The CLI keeps its token in the operating system keyring, never in a file.

## Interface

Use shadcn/ui components and patterns. Compose screens from them, and do not
invent custom visual controls.

## Assistant access

Expose tools to agents as a small set of plain MCP tools whose descriptions
are enough to use them correctly. Projects write their own rules for when
agents use Nook, so do not ship agent instructions for that.

## Package management

Use pnpm for installation, package execution, and scripts. Before installing
a package, verify its latest stable release and install that version. Do not
select beta, RC, canary, or other prerelease direct versions.

## Verification

Every change passes `pnpm verify`, locally and in CI. Do not weaken, skip,
or loosen a check to make a change pass. Fix the code, or raise the conflict
with the owner. Test observable behavior. Local runs and tests use a
synthetic owner and need no Cloudflare account or secret.

## Releases

Publish the CLI only by dispatching the release workflow from a green
`main`. Never create tags, releases, or assets by hand.

## Language

Write project content in English, including code, documentation, UI text,
and agent instructions. Communicate with the owner in Spanish.
