# Nook

Tools that AI agents use from any machine, running in your own Cloudflare account.

- **Memory:** a general memory organized in buckets (`me`, `work/project`, `personal`) that agents read and write over MCP and you browse in a web UI.
- **Vault:** secrets agents use through `nook run` without you pasting them into a conversation.

Nook is in early development. The owner manages hierarchical buckets and connected machines in the web app, and stores encrypted secrets in Vault. After saving, Vault shows only names and descriptions; replacing or deleting a value requires confirmation. Agents discover secrets in a bucket and its ancestors through MCP `list_secrets` or `nook vault list <bucket>`, within their grant. Agents use values through `nook run`; the owner reviews delivered uses and grant denials on Audit. Memory follows in a later change.

When approving CLI login on Linux or macOS, the owner chooses specific bucket subtrees or all buckets. Agents on that machine connect over MCP using `nook mcp-header`, which reads its credential from the system keyring. The CLI shows the grant with `whoami` and revokes it with `logout`; the owner can also revoke it from Machines.

## Install the CLI

```sh
mise use -g github:taecontrol/nook@latest   # Linux or macOS
brew install taecontrol/tap/nook            # macOS
```

`nook login https://<hostname>` connects a machine to an installation. See [deployment](docs/deployment.md#cli-and-the-machine-api-bypass) for the agent configuration and [releasing](docs/releasing.md) for how versions ship.

## Run a command with secrets

Commit a `nook.json` with environment names and full secret paths:

```json
{
  "secrets": {
    "GH_TOKEN": "work/acme/GH_TOKEN",
    "DB_URL": "work/acme/DB_URL"
  }
}
```

```sh
nook vault check
nook run --purpose "dev server" -- pnpm dev
```

The CLI searches from the real working directory up to the filesystem root and uses the nearest `nook.json`. Files are never merged. `vault check` uses metadata only: it prints each missing or denied mapping and exits 1, or reports that all distinct mapped secrets are available and exits 0. Checking does not fetch values, test decryption, or write audit entries.

`--secret` adds a variable or overrides the same environment name from the file. You can also use flags without a file:

```sh
nook run --secret GH_TOKEN=work/acme/GH_TOKEN --purpose "open the release PR" -- gh pr create
```

Repeat `--secret ENV=bucket/NAME` for more variables; repeated flag names are rejected. The merged mappings may contain at most 20 distinct paths, with multiple environment names allowed for the same path. A file holds references only, never secret values. Unknown top-level keys, malformed JSON, and invalid names or paths fail before keyring or network access, even when flags are supplied. An empty file needs at least one flag to run a command.

The purpose is required and must be one line of 1 to 200 characters. Nook resolves the command before contacting the keyring or server. It sends one value request, fetches each distinct path once, injects values only into the child's environment, and preserves stdin, stdout, stderr, TTYs, and the child's exit status. Any denied, missing, or undecryptable path prevents the command from starting; missing-path errors name every missing path. Values never appear in Nook's own output; the child controls its output.

Before delivering values, the Worker records one entry per secret, including the purpose, machine, working directory, executable, and time. Denied requests record only the denied paths. Audit entries are permanent and read-only, and retain their recorded machine name after revocation. Filter Audit by bucket subtree or exact secret path, including deleted secrets, and load older entries in pages of 25. A failed or lost value request is not retried automatically; a new request is a separate use.

## Run locally

Install [mise](https://mise.jdx.dev/), then run from the repository root:

```sh
mise install
mise exec -- pnpm install --frozen-lockfile
mise exec -- pnpm exec playwright install chromium
mise exec -- pnpm verify
mise exec -- pnpm dev
```

Open `http://127.0.0.1:4350`. Local development serves the production Worker and assets in workerd, with the fixed synthetic owner `owner@nook.test`. It requires no Cloudflare account, Access login, model credentials, or secret file. The synthetic identity is valid only on the exact loopback origin; `localhost` is a different hostname. Restart `pnpm dev` after changing source; it builds once on startup.

Local buckets and secrets use an in-memory D1 database, seeded with `me` by the migrations, and reset when the runtime restarts. Each local runtime generates a synthetic Vault key; no owner key is needed. Node and pnpm are pinned in [mise.toml](mise.toml). Use `pnpm dev --port 4351` to choose another unprivileged port. Linux CLI tests also require `dbus-run-session`, `dbus-send`, `gnome-keyring-daemon`, and `secret-tool` (`dbus`, `gnome-keyring`, and `libsecret-tools` on Ubuntu), plus util-linux `script` for the Linux TTY acceptance case. On a minimal Linux installation, Playwright may also need its documented operating-system browser dependencies.

## Layout

- `apps/worker`: Access verification, owner and machine APIs, and MCP.
- `apps/cli`: Linux and macOS login, identity, MCP headers, Vault discovery, audited commands, and logout with the operating system keyring.
- `apps/web`: React shell, shadcn/ui, TanStack Router and Query.
- `packages/contract`: the shared Effect `HttpApi` contract.
- `scripts`: builds, the local runtime, and verification.
- `tests`: HTTP acceptance tests in workerd, browser states, and deterministic journeys.

See [verification](docs/verification/README.md) for the checks and evidence, [deployment](docs/deployment.md) for installation configuration, and [ADRs](docs/adrs/) for the architectural decisions. [AGENTS.md](AGENTS.md) records the project's intent and obligations.

## License

[MIT](LICENSE)
