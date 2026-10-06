# Nook

Tools that AI agents use from any machine, running in your own Cloudflare account.

- **Memory:** a general memory organized in buckets (`me`, `work/project`, `personal`) that agents read and write over MCP and you browse in a web UI.
- **Vault:** secrets agents use through `nook run` without you pasting them into a conversation.

Nook is in early development. The owner manages hierarchical buckets and connected machines in the web app. When approving CLI login on Linux or macOS, they choose specific bucket subtrees or all buckets. Agents on that machine connect over MCP using `nook mcp-header`, which reads its credential from the system keyring. The CLI shows the grant with `whoami` and revokes it with `logout`; the owner can also revoke it from Machines. Memory and Vault content follow in later changes.

## Install the CLI

```sh
mise use -g github:taecontrol/nook@latest   # Linux or macOS
brew install taecontrol/tap/nook            # macOS
```

`nook login https://<hostname>` connects a machine to an installation. See [deployment](docs/deployment.md#cli-and-the-machine-api-bypass) for the agent configuration and [releasing](docs/releasing.md) for how versions ship.

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

Local buckets use an in-memory D1 database, seeded with `me` by the migrations, and reset when the runtime restarts. Node and pnpm are pinned in [mise.toml](mise.toml). Use `pnpm dev --port 4351` to choose another unprivileged port. Linux CLI tests also require `dbus-run-session`, `dbus-send`, `gnome-keyring-daemon`, and `secret-tool` (`dbus`, `gnome-keyring`, and `libsecret-tools` on Ubuntu). On a minimal Linux installation, Playwright may also need its documented operating-system browser dependencies.

## Layout

- `apps/worker`: Access verification, owner and machine APIs, and MCP.
- `apps/cli`: Linux and macOS login, identity, MCP headers, and logout with the operating system keyring.
- `apps/web`: React shell, shadcn/ui, TanStack Router and Query.
- `packages/contract`: the shared Effect `HttpApi` contract.
- `scripts`: builds, the local runtime, and verification.
- `tests`: HTTP acceptance tests in workerd, browser states, and deterministic journeys.

See [verification](docs/verification/README.md) for the checks and evidence, [deployment](docs/deployment.md) for installation configuration, and [ADRs](docs/adrs/) for the architectural decisions. [AGENTS.md](AGENTS.md) records the project's intent and obligations.

## License

[MIT](LICENSE)
