# Install Nook in your Cloudflare account

This guide installs one owner's Nook from a local checkout of this
repository. One command deploys it from your machine with your own Wrangler
login; Nook needs no CI and no Cloudflare API token. Replace `<hostname>`
with a dedicated hostname in your domain and `<team-name>` with your Zero
Trust team name. Installation settings stay in Cloudflare and on the command
line; you do not need to edit source or commit identifiers.

## 1. Prerequisites

- A Cloudflare account on **Workers Paid**. Workers Free is unsupported.
  See [Workers plans and limits](https://developers.cloudflare.com/workers/platform/limits/).
- A payment method for Zero Trust onboarding, including its Free plan,
  and for an R2 subscription. Enable R2 under **Storage & databases → R2 →
  Overview** and complete its checkout before deployment. See
  [Zero Trust setup](https://developers.cloudflare.com/cloudflare-one/setup/)
  and [R2 setup](https://developers.cloudflare.com/r2/get-started/).
- A domain with an **Active** DNS zone in that Cloudflare account. Choose
  an unused hostname; the deployment attaches it as the Worker's custom domain.
- No unrelated Worker or D1 database named `nook`, R2 bucket named
  `nook-files`, or Vectorize index named `nook-memories`. The deploy command
  deploys to this Worker name and reuses these resources; it must not overwrite or
  adopt another application's resources. Use a separate account
  if those names are already taken. This guide supports one installation
  per account.
- Linux or macOS with git, Node.js 26.10.0, and pnpm 12.8.1, the versions
  `package.json` requires. With mise, `mise install` in the checkout installs
  Node.js and pnpm.
- An email inbox for the owner's Access one-time PIN, a browser, `curl`,
  and OpenSSL for privately generating the Vault key.
- For the CLI: Linux or macOS on x64 or arm64. The mise release is one
  executable and needs no Node installation. Homebrew on macOS supplies
  its own Node. Linux needs an unlocked Secret Service, `dbus-send`
  (`dbus`), `secret-tool` (`libsecret-tools` on Ubuntu, `libsecret` on Arch),
  and `xdg-open` for browser approval. macOS uses the login Keychain,
  `security`, and `open`. The keyring must be available to the terminal and
  MCP client that run Nook.

## 2. Get the code and sign in to Cloudflare

```sh
git clone https://github.com/taecontrol/nook.git
cd nook
pnpm install
pnpm exec wrangler login
```

`wrangler login` opens a browser to authorize Wrangler for your Cloudflare
user, and keeps the credential on this machine. The deploy command uses it.
If `pnpm exec wrangler whoami` lists more than one account, set Nook's
account in the shell before each deployment:

```sh
export CLOUDFLARE_ACCOUNT_ID=<account-id>
```

`wrangler whoami` shows each account's ID, as does **Workers & Pages →
Account Details** in the dashboard. See [Wrangler login](https://developers.cloudflare.com/workers/wrangler/commands/general/#login).

## 3. Create the Zero Trust organization

Open **Zero Trust** in the Cloudflare dashboard and complete onboarding.
Choose a team name, select a plan (Zero Trust Free is sufficient for this
single owner), and enter payment details. You can find the team name later
under **Zero Trust → Settings**. Its issuer URL is
`https://<team-name>.cloudflareaccess.com`, without a trailing slash.

New organizations do not include one-time PIN automatically. In **Zero
Trust → Integrations → Identity providers**, choose **Add new identity
provider → One-time PIN**. This guide uses email PIN login so Access supplies
the owner's email. See [one-time PIN setup](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/one-time-pin/).
Other [identity providers](https://developers.cloudflare.com/cloudflare-one/integrations/identity-providers/)
can be configured separately; they must supply the same owner email claim.

## 4. Protect the whole hostname with Access

Before the first deployment, go to **Zero Trust → Access controls
→ Applications → Create new application → Self-hosted and private**.

1. Name it Nook. Select **Add public hostname** for `<hostname>` and leave **Path
   empty**. Protection must include `/`, all assets, owner APIs, `/mcp`, and
   the CLI approval page.
2. Add an **Allow** policy with **Include → Emails → your exact owner email**.
   Do not allow Everyone. Select **One-time PIN** as the application's login
   method; disable accepting all identity providers if necessary to select it.
3. Select **Create**. Edit the application, open **Advanced settings**, enable **Managed
   OAuth**, and save again. This lets owner MCP clients use the same Access
   policy. Nook verifies Access's forwarded assertion itself.
4. Open the application's **Configure → Additional settings** and retain
   its **Application Audience (AUD) Tag** privately for step 7. Use this
   whole-hostname application's audience, not the Bypass application's.

No Tunnel is needed: the deployment serves the hostname directly from Workers.
See [self-hosted applications](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/)
and [Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

## 5. Add the machine API Bypass application

Select **Create new application → Self-hosted and private → Add public
hostname** for a second Access application on the same hostname, with
**Path `api/machine/*`**. Give it a **Bypass** policy with **Include →
Everyone**. Select **Create** without adding Managed OAuth.

The more specific application wins. Keep the slash before `*`: neither
`api/*` nor `api/machine*` is safe. `/api/machines`, `/api/authorizations/*`,
`/cli/authorize`, `/`, assets, and `/mcp` must retain whole-hostname protection.
Only `/api/machine/*` uses Nook machine tokens; the Worker authorizes those
requests itself. See [Access path precedence](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/).

## 6. Run the first deployment

Run the deployment only after both Access applications exist. It attaches
`<hostname>` to the Worker, and without Access the app shell would be public.
From the checkout:

```sh
git switch main && git pull
pnpm run deploy <hostname>
```

Pass the hostname alone, without `https://`, a slash, or a path. The command
deploys only the commit that `main` on `origin` points to: it stops before
building when the checkout has uncommitted or untracked files, or sits at
another commit.
It does not run Verify again; changes reach this repository's `main` only
after Verify passes on their pull request.

The command installs the locked dependencies, builds, creates missing R2,
D1, and Vectorize resources, applies
D1 migrations, waits for the Vectorize `bucket` metadata index, and deploys
the `nook` Worker with `<hostname>` as its custom domain. Wrangler runs
without prompts, so it never writes resource IDs into `wrangler.jsonc`. Keep
resources private; no public R2 URL is required.

The first deployment ends with a notice that names the four missing Worker
secrets and points to step 7. This is expected: the Worker must exist before
you can enter its secrets. The check reads secret names only, and a failed
check does not change the deployment result. If a step fails, the command
names it and stops; fix the permission or configuration that Wrangler
reports, then run the command again. A rerun reuses what the failed run
created.

## 7. Set the Worker secrets

Open **Workers & Pages → nook → Settings → Variables and Secrets**.
Add these four entries with type **Secret**, then deploy/apply the changes:

| Name | Value |
| --- | --- |
| `ACCESS_ISSUER` | `https://<team-name>.cloudflareaccess.com`, exactly, with no trailing slash. |
| `ACCESS_AUDIENCE` | The whole-hostname Access application's AUD Tag from step 4. |
| `OWNER_EMAIL` | The exact email used in the owner Allow policy and one-time PIN login. |
| `VAULT_KEY` | Standard base64 encoding of 32 random bytes. |

Generate the key yourself in a private terminal, outside any agent session:

```sh
openssl rand -base64 32
```

Paste its output directly into the dashboard and keep a secure backup outside
Cloudflare. Never capture the output, send it to an agent, or commit it.
**Losing `VAULT_KEY` loses access to every stored secret value, including
values in database backups.** Replacing it is not key rotation. Memories
and secret metadata do not require that key. See [ADR-0006](adrs/0006-vault-values-encrypted-in-d1-under-a-worker-key.md).

Owner API requests return 401 until the three Access settings exist. A missing
or invalid Vault key prevents storing, replacing, revealing, and delivering
values. Later deployments preserve the secrets. See [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

## 8. Check the Access boundary while signed out

In the checkout, run `ls dist/assets/assets/*.js` to find a real current
hashed JavaScript asset from the deployment's build. Replace the asset placeholder below with
its `/assets/<filename>.js` path; a made-up path would test only a 404.
Use a signed-out shell without cookies or Access assertions. Do not follow
redirects:

```sh
origin='https://<hostname>'
asset='/assets/<current-hashed-filename>.js'
for path in / "$asset" /api/whoami /mcp /api/machines; do
  printf '%s ' "$path"
  curl --silent --show-error --output /dev/null \
    --write-out 'HTTP %{http_code}\n' \
    --header 'Authorization: Bearer nook-invalid' "$origin$path"
done
```

Each path must redirect to Access or receive an Access denial/Managed OAuth
challenge. None may serve the app, JavaScript, or a Worker 404. A status alone
can be ambiguous: privately inspect the response in a signed-out browser's
Network panel when needed to distinguish Access from the Worker's JSON
`Unauthorized` response. Record only statuses, not headers or response bodies.

The machine path must instead reach the Worker and return exactly its
401 `{"_tag":"Unauthorized"}`. This check retains the body only in a shell
variable and prints only the successful status:

```sh
reply=$(curl --silent --show-error --write-out '\n%{http_code}' \
  --header 'Authorization: Bearer nook-invalid' "$origin/api/machine/whoami")
if [ "$reply" = "$(printf '{"_tag":"Unauthorized"}\n401')" ]; then
  printf '/api/machine/whoami HTTP 401\n'
else
  printf 'Machine Bypass check failed; correct the Access applications before continuing.\n' >&2
fi
unset reply
```

If any check fails, correct steps 4–5 before continuing. In particular,
`/api/machines` must stay protected; it is not the Bypass prefix.

## 9. Sign in and connect your clients

Open `https://<hostname>/`, sign in with one-time PIN, and confirm that the
shell shows your email and Buckets includes `me`.

Nook serves ten tools at the owner MCP endpoint: `list_buckets`, `create_bucket`, `delete_bucket`, `list_secrets`, `remember`, `update`, `get`, `search`, `detach`, and `forget`.

### Owner MCP through Managed OAuth

For Claude Code:

```sh
claude mcp add --transport http nook https://<hostname>/mcp
```

Open Claude Code, use `/mcp` to authenticate Nook, and complete Access login
in your browser. Ask it to call `list_buckets` and confirm `me` appears.

For Codex, add this to your user `config.toml`:

```toml
[mcp_servers.nook]
url = "https://<hostname>/mcp"
```

Then run `codex mcp login nook`, complete Access login, and start Codex.
Ask it to call `list_buckets`. Complete OAuth before noninteractive
`codex exec`, which does not initiate this login. Owner MCP has access to
the whole bucket tree.

### CLI login

Install with mise on Linux or macOS, or Homebrew on macOS:

```sh
mise use -g github:taecontrol/nook@latest
# Alternative on macOS:
brew install taecontrol/tap/nook
```

```sh
nook login https://<hostname>
nook whoami
```

Login opens `/cli/authorize` and prints a code. Enter the code yourself in
the browser, name the machine, choose `me` for this installation check, and
choose how long access lasts (30 days by default, or No expiration), and
approve only a login you started. `whoami` shows the grant and expiry without a token.
The token stays in the OS keyring. If no browser opens, visit
`https://<hostname>/cli/authorize` yourself.

Selected roots allow read and write throughout their current and future
descendants. Limited machines can also read `me` and ancestors of their
roots. All buckets includes future buckets. To change access, use Edit access in Machines.
The new grant applies on the next request. Machines can also revoke access;
after revocation, `nook logout` clears the local credential before a new login.

### MCP on a machine with limited access

Use `https://<hostname>/api/machine/mcp` with the CLI credential helper.
`/mcp` remains the owner endpoint and does not accept Nook tokens.
Give the helper an absolute executable path, such as the mise shim path
or the Homebrew binary path. Keep its keyring available to the client.

For Claude Code, create a separate user-scope entry:

```sh
claude mcp add-json --scope user nook-limited \
  '{"type":"http","url":"https://<hostname>/api/machine/mcp","headersHelper":"/absolute/path/to/nook mcp-header"}'
```

For Codex, use a separate entry:

```toml
[mcp_servers.nook_limited]
url = "https://<hostname>/api/machine/mcp"
http_headers_helper = "/absolute/path/to/nook mcp-header"
```

Use only the helper for this entry; remove explicit Bearers or stored OAuth
credentials for it, which take precedence. Do not run `nook mcp-header`
directly: its stdout contains the credential and must go only to the client,
never a transcript or agent conversation. Ask the client to call `list_buckets`
and confirm that only its permitted tree, ancestors, and `me` appear.
See [Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication)
and [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

## 10. Store your first memory and secret

Ask the connected MCP client to call `remember` with this input:

```json
{
  "bucket": "me",
  "content": "# Installation check\nNook is running in my Cloudflare account.",
  "tags": ["install"]
}
```

Call `get` with the returned id and confirm the content. Open Memory in the
web app, choose `me`, and confirm the memory appears.

In your own terminal, create a disposable secret through the hidden prompt:

```sh
nook vault create me/SMOKE --purpose "install check"
nook run --secret SMOKE=me/SMOKE --purpose "install check" -- sh -c 'test -n "$SMOKE"'
```

The second command exits 0 without printing the value. Confirm that Vault
lists `SMOKE` and Audit records its delivered use. Do not ask an agent to
type or inspect the value. Agents discover names with `list_secrets` and
receive values only in a command's environment through `nook run`.
You may delete this disposable secret from Vault when finished.

## 11. Take upstream updates

From the checkout:

```sh
git switch main && git pull
pnpm install
pnpm run deploy <hostname>
```

To deploy your own changes, merge them into `main` in the repository the
checkout calls `origin`, after `pnpm verify` passes. The deploy command does
not run Verify.

If you installed through a GitHub fork and its Deploy workflow, syncing the
fork removes the workflow. Delete the fork's `CLOUDFLARE_API_TOKEN` secret and
its `CLOUDFLARE_ACCOUNT_ID` and `NOOK_HOSTNAME` variables, revoke the token in
Cloudflare, and deploy with the command above from then on.

Updates reuse D1, R2, and Vectorize, apply outstanding migrations before
the new Worker deploys, and preserve Worker secrets. Confirm your memory, `SMOKE` if retained, and
approved machine still exist. Keep the Vault key backup and follow the
[operational backup reference](deployment.md#back-up-a-database-with-full-text-search)
before changes that warrant a backup.

Update the Worker **before** the CLI: Nook does not check CLI/Worker version
compatibility. To stay on a particular release with mise, replace `latest`
with that release's `X.Y.Z` in the install command. `nook version` shows the
installed version. Review release notes before upgrading a pinned CLI.

## 12. Troubleshooting

For a Worker 401, 403, or expired-session screen after Access login, open
**Workers & Pages → nook → Observability → Logs** and select the request's
time range. Filter `event` equal to `auth-rejected`. Add a `reason` filter,
for example `reason` equal to `audience-mismatch`, to locate a specific
failure in one query. The record contains only the reason, method, pathname,
and, where relevant, setting or claim names.

Workers observability is enabled. Automatic invocation logs are deliberately
disabled because they include full request URLs; keep them disabled to avoid
recording query strings. Nook's custom rejection logs remain available.
Never add assertion headers, verifier errors, claim values, configured
values, or query strings to diagnostics. See [Workers Logs](https://developers.cloudflare.com/workers/observability/logs/workers-logs/).

| `reason` | What to check |
| --- | --- |
| `missing-config` | Set the secret names in `settings`: `ACCESS_ISSUER`, `ACCESS_AUDIENCE`, and/or `OWNER_EMAIL`, then apply the dashboard changes. |
| `issuer-not-https` | `ACCESS_ISSUER` must start with `https://` and use your Zero Trust team domain, without a trailing slash. |
| `no-assertion` | Check whole-hostname Access protection, the owner Allow policy, and Managed OAuth for MCP. Only `api/machine/*` may bypass Access. |
| `malformed-assertion` | Sign in again through Access; check that no proxy/client replaces the forwarded assertion. Do not inspect or share its value. |
| `algorithm-not-allowed` | Use Access's RS256 assertion and the correct Access application; Nook does not accept RS384/RS512. |
| `unknown-key` | Check `ACCESS_ISSUER` and retry a fresh Access login; the key must belong to that team's certificates. |
| `invalid-signature` | Check `ACCESS_ISSUER`, sign in again, and ensure the forwarded assertion is unmodified. |
| `expired` | Sign in again; check the Access session lifetime. |
| `not-yet-valid` | Check the identity provider's time settings and retry a fresh login. |
| `issuer-mismatch` | Match `ACCESS_ISSUER` to the Zero Trust team URL exactly, without a trailing slash. |
| `audience-mismatch` | Match `ACCESS_AUDIENCE` to the whole-hostname application's AUD Tag, not the machine Bypass application's. |
| `missing-claim` | The named `claim` (`email`, `sub`, or `exp`) is absent. Select one-time PIN or an identity provider that supplies these Access claims. |
| `certs-unavailable` | Check `ACCESS_ISSUER`, Access service availability, and the team's `/cdn-cgi/access/certs` endpoint; retry after recovery. |
| `not-owner` | Match `OWNER_EMAIL` and the application's owner Allow policy to the identity used to sign in. The response is 403. |
| `verification-failed` | Recheck the three Access settings and sign in again. Report only the reason, method, and pathname if it persists. |

If Access rejects a request at the edge, the Worker never receives it and
cannot log `auth-rejected`; check the Access application, policy, and selected
identity provider. Successful owner and synthetic local-owner requests do
not emit rejection logs. Machine-token rejections have no Access reason log.

The five-minute Cron retries memory indexing on its own, so a failed run
does not stop Nook. To see why meaning search lags behind D1, filter
`event` equal to `memory-sync-failed`. The `stage` field names the work
that failed (`sweep`, `embedding`, or `inspection`), and `error` holds the
failing service's message.

Other installation problems:

- **Deploy refused:** the command deploys only `origin`'s `main`. Commit or
  remove local changes, then run `git fetch origin && git switch --detach
  origin/main`, or `git switch main && git pull`, and run it again.
- **More than one account available:** set `CLOUDFLARE_ACCOUNT_ID` as in
  step 2.
- **Provisioning or deploy permission denied:** confirm that your Cloudflare
  user can manage Workers, D1, R2, Vectorize, and Workers AI in the account,
  and Workers Routes in the hostname's zone. Confirm R2 checkout is complete.
  Run `pnpm exec wrangler login` again if the login expired.
- **Missing Worker secrets after deployment:** follow the notice to step 7
  and set only the names listed. The check uses
  `wrangler secret list --format json`, which lists names and types, not
  values. Once all four names exist, the notice disappears. It cannot
  validate their contents. See [Wrangler secret list](https://developers.cloudflare.com/workers/wrangler/commands/workers/#secret-list).
- **The secret check could not run:** deployment succeeded but the name-only
  check failed. Confirm the four names privately in the Worker's dashboard;
  do not retrieve or log their values.
- **`VaultNotConfigured`:** set a valid base64-encoded 32-byte `VAULT_KEY`.
  If old values fail after the key changed, restore the original backup;
  a new random key cannot decrypt them.
- **CLI cannot save/read its credential:** unlock the Linux Secret Service
  or macOS login Keychain and retry. See [keyring recovery and internals](deployment.md#cli-keyring-internals).
- **MCP receives a redirect or cannot log in:** enable Managed OAuth on the
  whole-hostname application. Limited clients instead need the machine
  endpoint and a working absolute-path credential helper.
