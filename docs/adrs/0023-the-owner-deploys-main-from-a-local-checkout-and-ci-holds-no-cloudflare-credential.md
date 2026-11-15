# ADR-0023: The owner deploys `main` from a local checkout, and CI holds no Cloudflare credential

Date: 2026-11-15
Status: Accepted

## Context

Nook deployed through a GitHub Actions workflow. After Verify passed on a push to `main`, the workflow deployed that commit with a Cloudflare API token stored as a repository secret. The token needed Workers Admin on every Worker in the account, plus D1, R2, Vectorize, Workers AI, and the zone's Workers Routes.

The repository is public, but public readers could not reach the secret. Forks do not receive it, and pull requests from forks run Verify without it. Anyone with write access could, though: a workflow pushed to any branch can read every repository secret. The repository had two admins and an unprotected `main`, so the token's reach over the whole Cloudflare account depended on everyone with write access, now and later.

The workflow also made installation harder. A new owner had to fork the repository, enable Actions, create a token with seven permissions, enter three settings in GitHub, and wait about 15 minutes for Verify before every deployment.

## Decision

The owner deploys from a local checkout with `pnpm run deploy <hostname>`, using their own `wrangler login`. No workflow deploys, and GitHub stores no Cloudflare credential, account ID, or hostname.

The command deploys only the commit that `main` on `origin` points to, and refuses a checkout with uncommitted or untracked changes. It installs the locked dependencies before building. It does not repeat Verify. Instead, a ruleset on `main` requires a pull request and a green `verify` check before merge, with no bypass for admins.

## Consequences

- A leaked GitHub token or a compromised workflow can no longer reach the Cloudflare account. The credential lives only on the owner's machines, under Wrangler's login.
- Installation needs a clone, `wrangler login`, and one command. It no longer needs a fork, Actions, or an API token.
- Merging no longer deploys. The owner runs the command after each merge they want live.
- The ruleset does not require a pull request to be up to date with `main`, so two pull requests merged close together can reach `main` without having passed Verify together. Verify still runs on the push to `main` and shows its result on the commit, but the command does not check it. The owner accepted this risk.
- Every deployment runs on a machine the owner controls. If that machine is compromised, so is the Cloudflare login, as with any local Wrangler use.

## Alternatives considered

- **Keep the workflow and narrow the token**, by moving it to a GitHub environment that only `main` can use and scoping it to the `nook` Worker. Rejected: write access to `main` would still reach the token, and installation would keep its GitHub steps.
- **A local command for installation, with the workflow kept for the owner.** Rejected: the token would stay in GitHub only to save one command after each merge.
