# Verification

Run `pnpm verify` from the repository root with the pinned Node and pnpm versions. It stops on the first failure, in this order:

| Command | What it proves |
| --- | --- |
| `pnpm verify:style` | Biome formatting, recommended lint rules, and import order. |
| `pnpm verify:ui` | The web app composes shadcn/ui with theme tokens, static known classes, and the approved component composition rules. |
| `pnpm verify:types` | TypeScript checks the app, contract, tooling, and tests. |
| `pnpm verify:complexity` | Classic cyclomatic complexity is at most eight for each authored function. |
| `pnpm test:coverage` | Vitest tests the Node policies, the built Worker under workerd, and the shell in Chromium; then `e2e run --strict-cache` runs the deterministic owner journey with zero retries. |
| `pnpm verify:crap` | Complete, current execution evidence gives each scoped function a CRAP score at most eight. |
| `pnpm build` | Vite builds the SPA and esbuild bundles the Worker for workerd. |
| `pnpm verify:bundle` | Every cold-open script and modulepreload fits the committed gzip budget. |

`pnpm test` builds the production target before running Vitest. A narrow run such as `pnpm test tests/worker.test.ts` uses the same HTTP target. After `pnpm test`, `pnpm test:journey` runs the journey against that target. `pnpm test:coverage` prepares its own separately instrumented build and needs no prior build.

All local identities, signing keys, and issuer responses are synthetic. The runtime reads asset routing and compatibility settings from `wrangler.jsonc`, binds only to `127.0.0.1`, and takes explicit test bindings. Test port leases stay outside Linux's ephemeral range. No test reads production credentials or contacts a Cloudflare account. Coverage endpoints and counters exist only in the test build.

## Coverage and CRAP

The coverage inventory starts from original TypeScript and TSX, including files no test imports. [coverage.config.json](../../coverage.config.json) defines the scope: Worker, web, contract, and the Node policy modules in `scripts/lib`. Script entry points are orchestration and are covered by command and workflow acceptance checks; every authored script function still enters the complexity check. Unconfigured executable extensions fail inventory validation.

Unchanged CLI-generated shadcn components and their mobile hook are recorded by SHA-256 in [generated-components.json](generated-components.json). Changing one fails the inventory until it enters authored scope. The generated primitives retain their standard internal styles; authored composition still obeys all six UI rules. Declarations and dependencies do not enter authored coverage.

Istanbul instruments original sources before Node execution, Worker bundling, and browser compilation. Coverage artifacts in `.local/verification/coverage/` include a zero baseline, each seam's loaded-module hashes and counters, and a manifest of artifact hashes. Source identity includes app, contract, tooling, tests, documentation, workflows, configuration, and the lockfile, using repository-relative paths so a clean export and a CI shard agree.

CRAP rejects a missing baseline or seam, empty or unexecuted seam observations, stale source, unknown modules, incompatible counter maps or shapes, and altered artifacts. Coverage is the fraction of the function's own statements executed, excluding nested functions. A statement-free function uses its function counter. Classic complexity counts decisions independently for each function. The score is `complexity² × (1 − coverage)³ + complexity`.

CI runs the four static commands, three `pnpm test:coverage --shard=I/3` jobs, and a final job. Each shard uploads its manifest and artifacts; the final job requires the distinct indexes `1/3`, `2/3`, and `3/3`, identical source identities and baselines, and intact artifact hashes before CRAP, build, and the budget check. It needs no Cloudflare secrets.

## Browser evidence and budget

The shell suite captures all five accepted states at 1440×900 and 390×844 in both light and dark. It checks horizontal overflow, card bounds, rendered email line breaks after allowed separators, disabled future tools, mobile Sheet behavior, and the full-email dropdown with the Access logout destination. The twenty base screenshots and six overlay screenshots appear in `.local/verification/screenshots/` and CI's `web-shell-I` artifact. Compare them with the chosen prototype when changing the shell.

The journey uses exact locators and values, no model or live agent assertions. `.e2e/cache/` is committed and initially empty; recordings begin with the first tool journey. Reports, logs, videos, and failure artifacts stay ignored and are uploaded on CI failure.

[bundle-budget.json](../../bundle-budget.json) starts at 200,000 bytes. The check reads script and modulepreload URLs from the production `index.html`, counts each file once, and sums Node's gzip byte lengths. It retains the lowest valid committed ceiling in the full history of `HEAD`, `origin/main`, and local `main`, including both merge parents, so PR, push-main, and deployment checks reject a rise even when main points to the current commit. Malformed historical ceilings also fail. An exported tree still enforces the original maximum. Build-tool size summaries can use different compression defaults and are not the budget's measurement.
