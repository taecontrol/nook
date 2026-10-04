# Verification

Run `pnpm verify` from the repository root with the pinned Node and pnpm versions. It stops on the first failure, in this order:

| Command | What it proves |
| --- | --- |
| `pnpm verify:style` | Biome formatting, recommended lint rules, and import order. |
| `pnpm verify:ui` | The web app composes shadcn/ui with theme tokens, static known classes, and the approved component composition rules. |
| `pnpm verify:types` | TypeScript checks the app, contract, tooling, and tests. |
| `pnpm verify:complexity` | Classic cyclomatic complexity is at most eight for each authored function. |
| `pnpm verify:migrations` | D1 migrations replay on an empty, already-migrated, and populated previous schema; drift, edited published migrations, and explicit transactions fail. |
| `pnpm test:coverage` | Vitest tests the Node policies, the built Worker under workerd, and the shell in Chromium; then `e2e run --strict-cache` runs the deterministic owner journey with zero retries. |
| `pnpm verify:crap` | Complete, current execution evidence gives each scoped function a CRAP score at most eight. |
| `pnpm build` | Vite builds the SPA and esbuild bundles the Worker for workerd. |
| `pnpm verify:load-time` | The production first screens and navigation fit fixed load-time budgets on a 4G phone network. |

`pnpm test` builds the production target before running Vitest. A narrow run such as `pnpm test tests/worker.test.ts` uses the same HTTP target. After `pnpm test`, `pnpm test:journey` runs the journey against that target. `pnpm test:coverage` prepares its own separately instrumented build and needs no prior build.

All local identities, signing keys, and issuer responses are synthetic. The runtime reads asset routing and compatibility settings from `wrangler.jsonc`, binds only to `127.0.0.1`, and takes explicit test bindings. Test port leases stay above Fetch's blocked-port range and outside Linux's ephemeral range. No test reads production credentials or contacts a Cloudflare account. Coverage endpoints and counters exist only in the test build.

## Coverage and CRAP

The coverage inventory starts from original TypeScript and TSX, including files no test imports. [coverage.config.json](../../coverage.config.json) defines the scope: Worker, web, contract, and the Node policy modules in `scripts/lib`. Script entry points are orchestration and are covered by command and workflow acceptance checks; every authored script function still enters the complexity check. Unconfigured executable extensions fail inventory validation.

Unchanged CLI-generated shadcn components and their mobile hook are recorded by SHA-256 in [generated-components.json](generated-components.json). Changing one fails the inventory until it enters authored scope. The generated primitives retain their standard internal styles; authored composition still obeys all six UI rules. Declarations and dependencies do not enter authored coverage.

Istanbul instruments original sources before Node execution, Worker bundling, and browser compilation. Coverage artifacts in `.local/verification/coverage/` include a zero baseline, each seam's loaded-module hashes and counters, and a manifest of artifact hashes. Source identity includes app, contract, tooling, tests, documentation, workflows, configuration, and the lockfile, using repository-relative paths so a clean export and a CI shard agree.

CRAP rejects a missing baseline or seam, empty or unexecuted seam observations, stale source, unknown modules, incompatible counter maps or shapes, and altered artifacts. Coverage is the fraction of the function's own statements executed, excluding nested functions. A statement-free function uses its function counter. Classic complexity counts decisions independently for each function. The score is `complexity² × (1 − coverage)³ + complexity`.

CI runs the four static commands, three `pnpm test:coverage --shard=I/3` jobs, and a final job. Each shard uploads its manifest and artifacts; the final job requires the distinct indexes `1/3`, `2/3`, and `3/3`, identical source identities and baselines, and intact artifact hashes before CRAP, build, and the load-time check. The timing stage runs alone after test jobs finish. It needs no Cloudflare secrets.

## Browser evidence and budget

The shell suite captures all five accepted states at 1440×900 and 390×844 in both light and dark. It checks horizontal overflow, card bounds, rendered email line breaks after allowed separators, disabled future tools, mobile Sheet behavior, and the full-email dropdown with the Access logout destination. The twenty base screenshots and six overlay screenshots appear in `.local/verification/screenshots/` and CI's `web-shell-I` artifact. Compare them with the chosen prototype when changing the shell.

The owner journey uses a recorded `agent.act` to create `work/acme`, followed by an exact locator proving nesting inside `work`. Local recording uses the owner's ChatGPT subscription through `e2e/oauth/chatgpt`; credentials are never copied. Committed `.e2e/cache/` recordings replay in CI with `e2e run --strict-cache` and zero retries or model calls. Reports, logs, videos, and failure artifacts stay ignored and are uploaded on CI failure.

The bucket suite captures nine states at both viewport sizes, in light and dark: typical, fresh, deep-and-long, loading, load-error, ancestor preview, invalid path, delete confirmation, and after creating `work/acme`. The `buckets-*` PNGs share the screenshot artifact with shell evidence. Scenario controls and stubs are test fixtures and never enter the product.

The load-time stage uses Chromium against the uninstrumented production build and the same local runtime with the synthetic owner. It emulates 9 Mbps down, 3 Mbps up, and 85 ms latency, with cache disabled and no CPU throttling. Each result is the median of five runs. A cold `/` must show the signed-in owner's email within 1000 ms; a cold `/buckets` must show outline rows within 1000 ms. From home, after hovering Buckets until intent preloading settles, navigation must show rows within 100 ms. Constants live in `scripts/lib/load-time.ts`. Browser marks measure rendered screens across animation frames, excluding automation round trips. Medians, individual samples, and cold-open gzip bytes are printed; bytes are diagnostics and never gate.

## Migrations

`migrations/NNNN_name.sql` files are applied in order using Wrangler's SQL splitter and one atomic D1 batch per file, including its `d1_migrations` record. `migrations/schema.sql` is a snapshot, not a migration. The D1 binding's `migrations_pattern` selects only numbered files; a local Wrangler acceptance test proves that it excludes the snapshot and preserves replay. Verification uses fresh Miniflare databases, checks an idempotent replay, and applies the latest file to the previous schema containing a sentinel bucket. Both final normalized schemas must match the snapshot, and the sentinel must remain unchanged. A second migration enforces the reserved `me` invariant at the database boundary.

Fetch `origin/main` before verification: a migration present there cannot change or disappear. SQL errors, schema drift, and `BEGIN TRANSACTION` fail the gate. Deployment relies on the commit's successful Verify run instead of repeating it, builds, creates the named database if missing, applies remote migrations, then deploys the Worker. Production acceptance remains an owner step described in [deployment.md](../deployment.md).
