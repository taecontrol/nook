# Nook

Tools that AI agents use from any machine, running in your own Cloudflare account.

- **Memory:** a general memory organized in buckets (`me`, `work/project`, `personal`) that agents read and write over MCP and you browse in a web UI.
- **Vault:** secrets agents use through `nook run` without you pasting them into a conversation.

Nook is in early development. The owner manages hierarchical buckets and connected machines in the web app, and stores encrypted secrets in Vault. After saving, Vault shows only names and descriptions; replacing or deleting a value requires confirmation. Agents discover secrets in a bucket and its ancestors through MCP `list_secrets` or `nook vault list <bucket>`, within their grant. Agents use values through `nook run`; the owner reviews delivered uses and grant denials on Audit. Agents store memories over MCP, and the owner reads them in Memory with their recorded provenance.

When approving CLI login on Linux or macOS, the owner chooses specific bucket subtrees or all buckets. Agents on that machine connect over MCP using `nook mcp-header`, which reads its credential from the system keyring. The CLI shows the grant with `whoami` and revokes it with `logout`; the owner can also revoke it from Machines.

Follow [Install Nook in your Cloudflare account](docs/install.md) to set up your own installation and keep it updated through a GitHub fork.

## Install the CLI

```sh
mise use -g github:taecontrol/nook@latest   # Linux or macOS
brew install taecontrol/tap/nook            # macOS
```

`nook login https://<hostname>` connects a machine to an installation. See [client connections](docs/install.md#11-sign-in-and-connect-your-clients) for the agent configuration and [releasing](docs/releasing.md) for how versions ship.

Machine approval offers 1, 7, 30 or 90 days of access (30 days by default),
or No expiration. Existing machines keep no expiration. `nook whoami` shows
the expiry. Expired tokens stop working automatically; remove them in Machines,
and reconnect a machine with `nook logout && nook login <origin>`.

## Remember and read

The MCP `remember` tool takes an explicit existing bucket, Markdown content, optional tags, and an optional absolute `workingDirectory`:

```json
{
  "bucket": "work/acme",
  "content": "# Release process\nRun the release workflow from a green main.",
  "tags": ["deploy"],
  "workingDirectory": "/Users/luis/code/acme-api"
}
```

The result contains the memory id and metadata. `get({"id": "…"})` reads its exact content and provenance. Retrying byte-identical content in the same bucket returns that memory with `created: false`, preserves its tags, and writes nothing. A changed byte or a different bucket creates another memory. Content is limited to 16 KiB of UTF-8; tags are unique lowercase bucket segments, at most ten tags of 32 characters each.

Memory reads include the selected bucket, its ancestors, and `me`, within the caller's grant. In the web app, switch between that view and "Only this bucket", search by words or meaning, and open History to read earlier versions and changes. Each version records the authenticated principal, client as reported, optional working directory, and server time. Markdown renders without executing HTML or fetching remote images. Buckets holding memories cannot be deleted until their memories are forgotten.

Choose "Forget memory…" from a row's actions or the reading pane's More actions,
then confirm once. Agents call MCP `forget` with the id and the version from
`get` as `expectedVersion`. Forgetting permanently removes the memory, every
version and the keyword index entries; every Nook read and search excludes it
immediately. A changed version is rejected without deleting anything; read
again before deciding. A retry after successful forgetting answers "Memory
not found." There is no undo or trash. On healthy scheduled runs, Nook confirms
the meaning vector's absence after a 30-minute settle window, including late
embedding writes. Index outages retain the pending removal for another run.

Forgetting cannot guarantee physical erasure from Cloudflare storage. D1 may
keep deleted bytes in free pages and does not allow `secure_delete`.
[Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/)
keeps prior states for 30 days on Workers Paid and 7 days on Free; Nook cannot
purge them. Absence from Vectorize does not prove erasure from provider storage.

To replace a changed fact, call `get` first and pass its version as
`expectedVersion` to `update`, with the same id and new content. Omitted tags
are kept; `[]` clears them. A stale change is rejected, and another memory's
identical current content in the same bucket is named as a duplicate.
Retrying identical content and resulting tags returns `updated: false` when
they already match; another writer can make a retry stale. Updates preserve
the id, bucket, original creation time and earlier versions.

## Attach and download memory files

Use the id from MCP `get` or `search` with the logged-in CLI:

```sh
nook memory attach <id> ./guide.pdf
nook memory download <id> guide.pdf --output ./downloads/guide.pdf
```

Files may be up to 25 MiB each, with a 1 GiB quota per bucket. Attach uses the
path's base name: identical bytes leave the file unchanged, and different
bytes under the same name replace it. Files belong to the memory across text
versions. Both commands print one JSON metadata object. Download verifies the
size and SHA-256 before saving, refuses existing files, directories and
symlinks, and never writes file bytes to stdout. Without `--output`, it saves
under the file's name in the current directory; `--output -` is refused.

MCP `get` lists names, media types, sizes and digests; `search` includes file
counts and up to ten names and sizes. MCP carries no file bytes. Remove a file
with `detach({id, name, sha256})`, using the digest from `get`. Forgetting the
memory also removes its files. Audit records successful attaches, replacements,
downloads, detaches and forget deletions; an unchanged attach adds no entry.

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

```text
nook run --secret ENV=bucket/NAME --purpose "…" [--no-masking] [--approval <id>] -- <command>
```

```sh
nook run --secret GH_TOKEN=work/acme/GH_TOKEN --purpose "open the release PR" -- gh pr create
```

Repeat `--secret ENV=bucket/NAME` for more variables; repeated flag names are rejected. The merged mappings may contain at most 20 distinct paths, with multiple environment names allowed for the same path. A file holds references only, never secret values. Unknown top-level keys, malformed JSON, and invalid names or paths fail before keyring or network access, even when flags are supplied. An empty file needs at least one flag to run a command.

`NOOK_AGENT_SESSION`, `CODEX_SESSION_ID`, `CODEX_THREAD_ID`,
`CLAUDE_CODE_SESSION_ID`, and `CURSOR_CONVERSATION_ID` are reserved for agent
session claims. Mapping a secret to any of them, through `--secret` or
`nook.json`, fails before keyring or network access. `nook run`,
`nook vault create`, and `nook vault import` (on every key it creates)
automatically report one session from those variables:
Declared → Codex → Claude Code → Cursor. A declared session comes from
`NOOK_AGENT_SESSION`; Codex can also report a distinct thread. Valid values
contain 1–200 ASCII letters, digits, `.`, `_`, `:`, `~`, or `-`; invalid values
are ignored. Audit marks these claims as unverified and can filter by session.

The purpose is required and must be one line of 1 to 200 characters. Nook resolves the command before contacting the keyring or server. For unmarked secrets it sends one value request and fetches each distinct path once. It injects values only into the child's environment, and preserves stdin, TTYs, the order of stdout and stderr, and the child's exit status. Any denied, missing, or undecryptable path prevents the command from starting; missing-path errors name every missing path. Values never appear in Nook's own output.

When stdout or stderr is not a terminal, as when an agent captures the output, Nook replaces each exact occurrence of an injected value of 8 or more characters with its path, such as `<nook:work/acme/GH_TOKEN>`. A terminal receives the output unchanged. Masking is best effort, not a security boundary: it misses shorter values and transformed ones, such as base64 or URL-encoded, and a command can still send a value elsewhere. If the command leaves background processes writing to its output, Nook returns when the command exits and keeps masking their output until they close it. Pass `--no-masking` to receive the output unchanged.

When the owner has marked a bucket or secret as Ask first, `nook run` does not wait. It prints the secret paths, an approval URL, the remaining time and an attempt id on stderr, exits 75 and starts nothing, so an agent can give the owner the link at once. Run the same command again with `--approval <id>` after `nook run`: that run waits for the owner's decision, up to ten minutes from the first run. The owner can approve only this attempt, remember approval for 1 hour or 12 hours on the same machine, or deny. Remembered approval covers the same or fewer marked secrets across agent sessions, and later runs need no `--approval`; it never widens the machine's bucket grant. Denial exits 77 with ‘Nothing was delivered.’ Expiry, an exhausted wait or the pending-request limit exits 75; run again without `--approval` to ask again. SIGINT and SIGTERM withdraw a waiting request best effort and exit 130 and 143. Update older CLIs to use covered secrets: released versions that cannot ask receive an update message and no value. The CLI still propagates the child's exit code once the command starts.

Before delivering values, the Worker records one entry per secret, including the purpose, machine, working directory, executable, and time. Denied requests record only the denied paths. Audit entries are permanent and read-only, and retain their recorded machine name after revocation. Filter Audit by bucket subtree or exact secret path, including deleted secrets, and load older entries in pages of 25. Before any pending answer, a failed or lost value request is not retried automatically. During approval wait, transient failures are retried with the same attempt id until its deadline; running the command again without `--approval` creates a separate attempt.

## Store a new secret

```sh
provider-cli new-token | nook vault create work/acme/NEW_TOKEN --purpose "token from provider setup" --description "Provider API token"
```

Import a local `.env` without reading its values into the conversation:

```sh
nook vault import work/acme .env --purpose "migrate acme env"
```

The CLI parses dotenv syntax locally, imports up to 100 keys and never changes the file. Invalid names and duplicate new names block the import before any write. Empty values, values over 64 KiB and values containing NUL are skipped. Existing names in that bucket are left unchanged. The report names each result and prints a `nook.json` block for created and existing keys without writing it to disk. Keys named like an agent session variable are left out of the block with a note to map them under another name, and a block of more than 20 keys notes that `nook run` uses at most 20. A failed or unconfirmed write exits with status 1; rerunning safely skips names already stored.

In the Vault web app, choose **Import .env**, paste your file and select a bucket. Review the names, fix problems and create the checked keys together. Existing secrets are skipped. Values stay hidden after review; use **Retry failed** for any remaining keys, then **Done** to discard the import.

The value travels directly from stdin to Vault. Nook removes exactly one trailing LF or CRLF, preserves other whitespace, and accepts at most 64 KiB of valid UTF-8 without NUL. From a terminal it asks for a hidden value. A purpose is required; the description is optional. Values cannot be passed as arguments. Existing names are never overwritten, and machines cannot replace or delete secrets.

The bucket must already exist within the machine's write grant. Each successful creation records its path, purpose, machine, working directory, and time in the same Audit ledger as uses, with outcome `Created`. Denied attempts and owner web creations add no creation entry. Retries reuse one write id, so a lost response cannot duplicate the creation or its audit entry. If the result cannot be confirmed, Nook says so.

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

See [verification](docs/verification/README.md) for the checks and evidence, [installation](docs/install.md) for setup and updates, [operations](docs/deployment.md) for backups and storage limits, [Memory implementation](docs/memory.md) for storage ownership, and [ADRs](docs/adrs/) for the architectural decisions. [AGENTS.md](AGENTS.md) records the project's intent and obligations.

## License

[MIT](LICENSE)
