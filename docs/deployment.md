# Deployment configuration

Each installation belongs to one owner in their Cloudflare account. Account IDs, hostnames, Access settings, and credentials stay outside source. `wrangler.jsonc` disables `workers.dev` and preview URLs. Static documents and assets are served by the asset layer; Cloudflare Access must protect the entire hostname, including those paths.

The installation owner supplies the following settings:

| Name | Destination | Source |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repository **Settings → Secrets and variables → Actions → Variables** | Cloudflare **Workers & Pages → Account Details → Account ID**, or dashboard search **Copy account ID**. |
| `NOOK_HOSTNAME` | The same GitHub repository variables | The installation's hostname, without scheme or path. Its DNS zone must be active in the chosen Cloudflare account. |
| `CLOUDFLARE_API_TOKEN` | GitHub repository **Settings → Secrets and variables → Actions → Secrets** | Create an account API token from the **Edit Cloudflare Workers** permission template, scoped to this account and the hostname's zone. Include **Account → D1 → Edit**, **Account → Workers R2 Storage → Edit**, **Account → Vectorize → Edit**, and **Account → Workers AI → Read and Edit** for database migrations, search provisioning, and the AI binding. Initial creation requires the Workers product **Admin** role; an **Editor** can maintain an existing Worker. Changing a custom domain also needs **Zone → Workers Routes → Write** for that zone. |
| `ACCESS_ISSUER` | Worker **nook → Settings → Variables and Secrets**, type **Secret** | `https://<team-name>.cloudflareaccess.com`, with no trailing slash. Find the team name under **Zero Trust → Settings**. |
| `ACCESS_AUDIENCE` | The same Worker secrets | **Zero Trust → Access controls → Applications → the Nook application → Configure → Additional settings → Application Audience (AUD) Tag**. |
| `OWNER_EMAIL` | The same Worker secrets | The exact email the owner's identity provider supplies to Access; use the same identity in the application's Allow policy. |
| `VAULT_KEY` | The same Worker secrets | Standard base64 of 32 random bytes, generated privately with `openssl rand -base64 32`. Keep a backup outside Cloudflare. |

Never paste secret values into an agent conversation, commit them, or put them in command arguments or logs. Set them directly through their dashboards. No local secret file is necessary.

Before the first deployment, create a self-hosted Access application with a public hostname matching the installation's entire hostname, with the path left empty. Choose the owner's identity provider and an Allow policy for the owner's email. The static shell and hashed assets rely on whole-hostname protection at the edge. The only Bypass exception is the separate machine API application below. The full Access provisioning guide belongs to the installation work.

Every push to `main` deploys itself. When **Verify** succeeds on a `main` push, the Deploy workflow starts for that exact commit. It deploys only while `main` still points to that commit; when a later merge has moved `main`, it skips, because the later commit's own run deploys it. It checks the commit's successful Verify run, builds the product from that commit, and only then deploys using the repository settings. An installation without the `NOOK_HOSTNAME` variable, such as a fork that is not configured yet, skips automatic deployment. To redeploy by hand, use **Actions → Deploy → Run workflow** and select **main**; dispatches on other branches skip the deployment job.

The workflow creates the R2 bucket configured by `r2_buckets[].bucket_name` for binding `FILES` when missing, creates the `nook` D1 database when missing, applies its migrations, provisions the configured Vectorize index and its indexed `bucket` metadata when missing, and then deploys the Worker and custom domain. Provisioning finishes before any embedding writes. The index name lives in `wrangler.jsonc`; D1 resolves by database name, without a committed database ID. If the Worker did not already exist, add its three Access secrets and `VAULT_KEY` through the Worker settings afterwards and apply the secret changes there. Until all three Access secrets exist, owner-authenticated Worker requests return 401. Machine API requests use their separate credential boundary. Later workflow deployments preserve those secrets. The owner can also provision the Worker secrets beforehand through their own Cloudflare administration.

Complete production acceptance by recording a successful main deployment. In a fresh signed-out browser, confirm that `/`, a real hashed JavaScript asset, `/api/whoami`, and `/mcp` redirect to Access or are denied; none may serve the app or asset. Then sign in as the owner and capture the shell showing that identity. Retain outcomes and screenshots without cookies, JWTs, or secret values.

Sources: [Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/), [CI authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Worker permissions](https://developers.cloudflare.com/workers/authorization/workers/), [Access audience and issuer](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

For bucket acceptance after this change merges, add **Account → D1 → Edit** to `CLOUDFLARE_API_TOKEN` in the Cloudflare token dashboard. Merging deploys automatically once Verify passes on `main`. Sign in as the owner, confirm `GET /api/buckets` lists `me`, create a bucket in the outline, and record the result on the pull request. Do not share the token or Access assertion.

## Vault key and post-deployment smoke test

Set `VAULT_KEY` as a **Secret** on the `nook` Worker, next to the Access secrets. Generate it privately with `openssl rand -base64 32`, paste it directly into the Cloudflare dashboard, and keep a secure backup outside Cloudflare. Do not run key generation through an agent or include its output in a transcript. Losing the key makes existing values unreadable; replacing it is not key rotation. Listing and deleting metadata work without a key, but create and replace return `VaultNotConfigured` until a valid key is configured. See [ADR-0006](adrs/0006-vault-values-encrypted-in-d1-under-a-worker-key.md) and [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

Vault stores AES-GCM ciphertext in D1. Delete and replace remove the current ciphertext, but [D1 Time Travel](https://developers.cloudflare.com/d1/reference/time-travel/) retains previous database states during its retention window. Nook does not purge that history.

Memory forgetting removes the canonical memory, all versions and keyword
postings in one atomic write. D1 can still keep deleted bytes in free pages;
`secure_delete` is unavailable. Time Travel keeps prior database states for
30 days on Workers Paid and 7 days on Free, including forgotten memories.
Nook cannot purge either. Meaning vectors are removed and their absence
confirmed after a 30-minute settle window on healthy scheduled runs. A vector
absent from Vectorize does not prove erasure from provider storage.

Attached files use R2 encryption at rest, without application-level encryption.
D1 file rows decide availability and the bucket's 1 GiB usage; each file is
limited to 25 MiB. Forget and detach remove those rows and add audit entries
atomically, so subsequent downloads cannot fetch the file. Inline object
removal follows a successful commit. If it fails or the Worker stops, the
five-minute Cron walks one R2 page per invocation and removes unreferenced
objects older than 60 minutes. Physical R2 removal can therefore take the
60-minute grace plus a complete successful sweep walk. Publication uses a
strict ten-minute D1 clock window and keys are never reused, keeping cleanup
safe against delayed writers. Provider retention remains outside Nook's
erasure guarantee.


After merging and the green-main deployment, the owner performs these checks. Local workerd tests prove the same behavior, but production foreign-key enforcement and an approximately 85 KiB ciphertext bound parameter still need this observation.

1. In the production database's D1 console, run `PRAGMA foreign_keys;` and require `1`. Cloudflare documents [foreign-key enforcement](https://developers.cloudflare.com/d1/sql-api/foreign-keys/) by default.
2. Sign in to Nook as the owner. In that tab's browser console, run the synthetic smoke test below. It creates a unique temporary bucket and a 64 KiB ASCII value, checks that deleting its nonempty bucket returns the exact blocker, then deletes the secret and bucket. It prints only metadata and statuses.

```js
const bucket = `vault-smoke-${crypto.randomUUID().slice(0, 8)}`;
const headers = { 'Content-Type': 'application/json' };
const madeBucket = await fetch('/api/buckets', {
  method: 'POST', headers, body: JSON.stringify({ path: bucket }),
});
if (madeBucket.status !== 200) throw new Error('Smoke bucket creation failed.');
const stored = await fetch('/api/secrets', {
  method: 'POST', headers,
  body: JSON.stringify({
    bucket, name: 'SIZE_SMOKE', description: 'Synthetic 64 KiB smoke test',
    value: 'x'.repeat(64 * 1024), writeId: crypto.randomUUID(),
  }),
});
if (stored.status !== 201) throw new Error('64 KiB create failed.');
const metadata = await stored.json();
const blocked = await fetch(`/api/buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' });
const blocker = await blocked.json();
if (blocked.status !== 409 || blocker.message !== 'Delete its secrets first.')
  throw new Error('Nonempty bucket deletion was not blocked.');
const removed = await fetch(`/api/secrets/${encodeURIComponent(metadata.path)}?version=${encodeURIComponent(metadata.version)}`, { method: 'DELETE' });
const cleaned = await fetch(`/api/buckets/${encodeURIComponent(bucket)}`, { method: 'DELETE' });
console.info({ bucket, createStatus: stored.status, blockedStatus: blocked.status,
  deleteSecretStatus: removed.status, deleteBucketStatus: cleaned.status });
```

Require create `201`, blocked bucket delete `409`, and both cleanup deletes `204`. If a check fails, retain the temporary bucket's name for cleanup and report the status without response payloads or credentials. Record the foreign-key result and smoke outcomes on the PR. Finally, open Vault and confirm the stored/inherited grouping, then use `list_secrets({ bucket: 'me' })` or `nook vault list me` to discover names and descriptions. These interfaces never return values; CLI writes and value delivery are later features.

### Reveal a value in the web app

After deploying the reveal migration, sign in as the owner and store a temporary
synthetic value in Vault. Choose **Reveal value…** from its menu, copy it, close
the dialog, and confirm that reopening it adds a second **Revealed** entry in
Audit. The details should show **Web app**, **Revealed in web app**, and the
request's IP address and country. These facts come from Cloudflare at the edge;
local tests supply synthetic equivalents. Remove the temporary secret when
finished. Record statuses and audit metadata only on the PR.

The reveal route belongs to the existing whole-hostname Access application,
outside the machine Bypass. It needs no new Access configuration. A missing
`VAULT_KEY` prevents revealing, just as it prevents storing or replacing a
value. The owner's accepted level-1 scope also admits Access Managed OAuth
assertions; the origin cannot distinguish them from browser sessions.

## Memory file E31: owner acceptance after deployment (pending)

After the complete file feature merges and green main deploys, confirm that
the workflow created the configured R2 bucket. The deployment token needs
[R2 account permissions](https://developers.cloudflare.com/r2/api/tokens/) to list and create R2 buckets. CLI publishing remains a separate
dispatch of the release workflow from green main.

Using a CLI version that includes file commands, privately attach a synthetic
25 MiB file from one machine and download it on another machine with the same
bucket grant. Require equal local SHA-256 digests. Then download it through
the owner's Files drawer and confirm the owner principal, IP and country in
Audit. Record statuses, digest and deployment evidence without credentials or
file bytes. This capture checks hosted isolate headroom, real R2 behavior and
the owner authentication path; local Miniflare cannot establish them.


## Remote MCP and Access Managed OAuth

Nook serves `list_buckets`, `create_bucket`, `delete_bucket`, `list_secrets`, `remember`, `update`, `get`, and `search` at `https://<hostname>/mcp`. The owner authenticates through the existing Access application with access to the whole bucket tree. The Worker verifies the forwarded Access assertion before MCP. Nook machine tokens use the separate `/api/machine/mcp` endpoint described below.

In **Zero Trust → Access controls → Applications**, edit the existing self-hosted Nook application. Under **Advanced settings**, enable **Managed OAuth**, then save. Keep its whole-hostname protection and owner Allow policy. Access supplies the OAuth flow and forwards the user's JWT in `Cf-Access-Jwt-Assertion`; Nook does not implement an OAuth server. See [Cloudflare Managed OAuth](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/).

MCP accepts requests without `Origin` or with the endpoint's own origin. It rejects any other Origin and sends no CORS headers. Each tool call takes one HTTP request; clients do not need a session ID or GET stream.

### Connect Claude Code

Run this on the owner's machine, replacing `<hostname>` with the installation hostname:

```sh
claude mcp add --transport http nook https://<hostname>/mcp
```

Open Claude Code, use `/mcp` to authenticate Nook, and complete the Access login in the owner's browser. Ask it to call `list_buckets`. Tool descriptions require choosing the bucket explicitly and confirming with the owner before creating or deleting one.

### Connect Codex

Add the remote server to the owner's Codex `config.toml`:

```toml
[mcp_servers.nook]
url = "https://<hostname>/mcp"
```

Then run:

```sh
codex mcp login nook
```

Complete Access login in the owner's browser, start Codex, and ask it to call `list_buckets`. Perform the login before noninteractive `codex exec`; the observed client does not initiate OAuth from that command.

### Owner acceptance after deployment

These checks require the production deployment and the owner's browser login. Local tests prove the Worker and client protocol behavior with synthetic Access assertions; they cannot prove Access Managed OAuth or the hosted client logins.

For E13, request `/mcp` without cookies or credentials. Print only its status and discovery challenge:

```sh
curl --silent --show-error --output /dev/null \
  --write-out 'HTTP %{http_code}\nWWW-Authenticate: %header{www-authenticate}\n' \
  --request POST \
  --header 'Accept: application/json, text/event-stream' \
  --header 'Content-Type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' \
  'https://<hostname>/mcp'
```

Expect HTTP 401 and `WWW-Authenticate` pointing to OAuth discovery metadata. Confirm that `https://<hostname>/.well-known/oauth-protected-resource` provides protected resource metadata. Access handles this unauthenticated challenge at the edge; the local Worker only returns its ordinary 401. See [Access authorization flow](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/managed-oauth/#authorization-flow).

For E14, complete both client connection flows above and record successful `list_buckets` calls. With one client, confirm a bucket creation with the owner and call `create_bucket`. Return to the open `/buckets` tab and confirm that the new bucket appears under its parent without reloading. Returning refetches the tree once, even when its cached data is still fresh.

Record E13 and E14 outcomes on the pull request without tokens, cookies, assertions, or secret values. The owner completes these captures after deployment.

## Memory search

Search combines exact words with meaning across the selected bucket, its ancestors, and `me`, within the caller's grant. Exact words are available when `remember` succeeds. Embeddings are written afterwards; Vectorize can take about a minute to expose them. The five-minute Cron Trigger repairs up to 50 pending or outdated memories per run, including memories stored before search was installed. Changing `EMBEDDING_MODEL` in configuration schedules re-embedding; the index still requires 1,024-dimensional vectors.

Vectorize [creates metadata indexes asynchronously](https://developers.cloudflare.com/vectorize/get-started/intro/).
Deployment waits for the string `bucket` index to appear in
`list-metadata-index`, with up to 20 checks three seconds apart. If it never
becomes ready, deployment stops before the Worker can write vectors without
indexed bucket metadata. A rerun uses the existing ready index.

The [Vectorize Free allowance](https://developers.cloudflare.com/vectorize/platform/pricing/) is five million stored dimensions per account. At 1,024 dimensions per memory, that is 4,882 memories, approximately 4,900, less other indexes' usage. Beyond that capacity, upserts fail and pending memories remain searchable by exact words. Meaning service failures produce an explicit incomplete-results notice. Nook does not enforce a separate quota.

### Search E24: owner acceptance after merge (pending)

1. Privately add **Account → Vectorize → Edit** and **Account → Workers AI → Read and Edit** to the deployment token. See Cloudflare's [token permissions](https://developers.cloudflare.com/fundamentals/api/reference/permissions/) and [Workers AI authentication](https://developers.cloudflare.com/workers-ai/get-started/rest-api/). Retain the existing Workers, D1, and zone permissions.
2. After green `main` deploys, confirm that its workflow provisions the configured index and string `bucket` metadata index. If the automatic deployment ran before the permission change, dispatch **Deploy** from green **main**.
3. Allow the scheduled repair to index pre-existing memories. In the connected Claude Code session, call `search` with an explicit bucket and a paraphrase or other-language query for a memory stored before this merge. Confirm a relevant `meaning` or `both` result from the permitted lineage, then call `get` with its id.
4. Record the deployment run, client version, permitted bucket, result id and match type on the PR. Leave E24 pending until this production observation succeeds; exclude credentials and private memory content from the capture.

### Memory update E31: owner acceptance after deployment (pending)

After merging issue #12 and deploying green main, the owner performs this
check privately against the hosted Worker and Vectorize index. Local
workerd evidence does not establish hosted `getByIds` metadata or freshness.

1. Read a real memory with `get` and retain its version. Choose an old-only
   word and replacement content containing a new-only word. Call `update`
   with that `expectedVersion`; confirm the same id, a new version and the
   original `createdAt`. Open History and confirm both versions and writers.
2. Immediately search for the old-only word through MCP and the owner web
   app. It must no longer match this memory or quote its old text. The
   new-only word must find its current version by keyword. After vector
   propagation, confirm the replacement by meaning as well.
3. Leave the memory unchanged for at least ten minutes. Observe a scheduled
   invocation through Cloudflare's private diagnostics and confirm its
   inspection completes: `getByIds` returns the vector's metadata, including
   `contentHash` and the bucket digest. A complete rotating sweep takes about
   `ceil(N / 50)` scheduled runs. Do not add a public debug endpoint or log
   memory content, credentials, vector values or private metadata.
4. Record the deployment run, client version, update outcome, search
   outcomes, scheduled run time and inspection-success boolean on the PR.
   Keep E31 pending until these observations succeed. If hosted inspection
   omits metadata, stop and revisit ADR-0014 instead of changing the
   inspection policy silently.

### Forget: owner acceptance after deployment (pending)

After merging issue #13 and deploying green main, perform this check privately
with synthetic memories. Migration 0011 must be applied before the new Worker;
it is additive and needs no vector backfill.

1. Read a synthetic memory with MCP `get`, then `forget` with its version.
   Confirm the compact result, immediate not-found detail/history, absence
   from lists/counts and both searches, and the not-found retry. Repeat from
   the web confirmation at desktop and phone sizes.
2. Use private Cloudflare diagnostics to exercise the native
   `deleteByIds` binding with 50 synthetic ids, including an unknown UUID.
   Confirm it accepts the size and unknown id without stalling removal.
   The production sweep inspects first and deletes only present forgotten
   ids, in one call of at most 50; the hosted size and unknown-id behavior
   are not documented by the [client API](https://developers.cloudflare.com/vectorize/reference/client-api/).
3. Observe scheduled removal and actual index propagation. The pending id/time
   must survive early absence and outages, then disappear only after a run
   observes vector absence at least 30 minutes after forgetting. Confirm
   propagation stays within the 15-minute margin used by
   [ADR-0015](adrs/0015-forgetting-is-version-guarded-and-vector-removal-settles-after-late-writers.md).
4. Record the deployment run, call-size/outcome booleans, scheduled timestamps
   and propagation duration on the PR. Keep this hosted acceptance pending
   until they succeed. A rejected batch size, unknown-id failure that stalls
   the sweep, or propagation beyond the margin requires re-entering design.

Do not publish content, vector values, credentials or private bucket names.
Index absence establishes convergence, not physical erasure by the provider.

### Back up a database with full-text search

Cloudflare [does not support D1 exports containing virtual tables](https://developers.cloudflare.com/d1/best-practices/import-export-data/#known-limitations). Full `pnpm exec wrangler d1 export nook --remote --output owner-backup.sql` therefore fails while `memories_fts` exists. Time Travel remains available. For a SQL export, the owner uses a maintenance window: stop memory writes, remove only the derived search objects below, export, and immediately recreate them even if export fails.

```sql
DROP TRIGGER memories_fts_version_insert;
DROP TRIGGER memories_fts_current_update;
DROP TRIGGER memories_fts_delete;
DROP TABLE memories_fts;
DROP VIEW memory_current;
```

Execute that SQL privately in D1, then export to an owner-controlled file. Recreate the objects using [0010_memory_search.sql](../migrations/0010_memory_search.sql) **starting after its first `ALTER TABLE` statement**, including the final `rebuild`. The existing embedding marker column must not be added twice. Search is unavailable during this window; canonical memories and versions stay intact. Keep backup contents out of agent context.

After restoring the export into a new database, recreate these same derived objects, clear `memories.embedding_marker` to `NULL`, and let Cron rebuild the vectors in the correctly provisioned index. Never edit or prune version rows to rebuild search. [ADR-0013](adrs/0013-search-indexes-derive-from-d1-and-converge-eventually.md) records why both indexes are disposable while D1 remains authoritative.

## CLI and the machine API Bypass

Keep the whole-hostname Access application, its owner Allow policy, and Managed OAuth. Create a **second self-hosted Access application** with the same public hostname and the path **`api/machine/*`**. Give it a **Bypass** policy with **Include → Everyone**. Do not broaden it to `api/*` or `api/machine*`, or add owner routes beneath it. `/cli/authorize`, `/api/authorizations/*`, `/api/machines`, `/`, assets, and `/mcp` stay protected by the original application.

The more specific path application wins. The slash before `*` ensures that `api/machine/*` does not cover `/api/machine` or `/api/machines`. Access selects paths, not Nook Authorization headers. The Worker accepts Nook tokens only in this prefix; Access and the synthetic owner never authenticate a machine there. See [ADR-0010](adrs/0010-machine-tokens-only-under-the-machine-api-prefix.md), [Access paths](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/app-paths/), and [Bypass policies](https://developers.cloudflare.com/cloudflare-one/access-controls/policies/#bypass).

Install the CLI with mise on Linux or macOS, or with Homebrew on macOS:

```sh
mise use -g github:taecontrol/nook@latest
brew install taecontrol/tap/nook
```

The mise build is a single executable that needs no Node. The Homebrew formula builds the CLI from source and runs it on Homebrew's Node. On Linux, the CLI uses an unlocked Secret Service, `dbus-send` (`dbus`), and `secret-tool` (`libsecret-tools` on Ubuntu, `libsecret` on Arch). On macOS, it uses the default login Keychain and the system `security` command:

```sh
nook login 'https://<hostname>'
nook whoami
nook logout
nook version
```

From a clone, `pnpm build` produces the same CLI as `dist/cli.js` for the pinned Node 26.10.

Login prints a code and tries the platform browser opener with the bare `/cli/authorize` URL. Enter the terminal code, choose its buckets, name the machine, and approve only a login you started. The initial choice is only `me`. Checked buckets permit read and write throughout their current and future descendants. A limited machine can also read `me` and the ancestors of its selected roots; other buckets stay hidden. All buckets includes current and future buckets. To change access, use Edit access in Machines. The new grant applies on the machine's next request, with the same token and no new login. If the machine was revoked in Machines, run `nook logout` to clear the saved credential before logging in again.

The Secret Service item has `service=nook` and `url=<origin>`. Its label holds the machine name; its value reaches `secret-tool store` only through stdin. `$XDG_CONFIG_HOME/nook/config.json` (default `~/.config/nook/config.json`) holds only the URL. Logout clears the item only after revocation succeeds or the Worker confirms an invalid token. On macOS, a generic password has service `nook`, account `<origin>`, and the same machine-name label. `security -i` receives one quoted command on stdin, including the token; the token never enters argv. Login, identity, and logout wait up to two minutes for Keychain access. Unlock the login keychain when prompted, then try again if the command times out. The CLI opens the approval URL with `open` on macOS and `xdg-open` on Linux.

An empty or relative `XDG_CONFIG_HOME` uses the default directory. If login cannot save its keyring entry or URL, it revokes the newly issued token and clears any partial keyring entry. If revocation also fails, the CLI keeps any saved keyring entry and gives recovery guidance. Fix the configuration path and keyring, then repeat `login <origin>` to restore the URL when a saved entry exists, without creating another request; `logout` can then revoke the session.

Login and logout coordinate through a Linux abstract socket for the OS user and the actual session bus ID obtained with `dbus-send`. Equivalent bus addresses and different config directories therefore protect the same keyring. A concurrent session command reports that another command is in progress; try again after it finishes. The kernel releases the socket on exit, including a crash. It carries no credential and creates no file. On macOS, an exclusive kernel lock protects an empty `~/Library/Application Support/nook/session.lock`. It is keyed by HOME, so changing `XDG_CONFIG_HOME` cannot bypass coordination. The file stays in place; closing the descriptor or exiting, including SIGKILL, releases the lock.

### E25: owner acceptance after deployment

E25 is pending until the owner configures Bypass and tests production. In a signed-out shell with no cookies or Access assertion, use this intentionally invalid Bearer:

```sh
curl --silent --show-error --include \
  --header 'Authorization: Bearer nook-invalid' \
  'https://<hostname>/api/machine/whoami'
```

Expect the Worker's **401 JSON** `{"_tag":"Unauthorized"}`. Print only statuses and the discovery header for protected paths:

```sh
for path in api/machines api/whoami '' mcp; do
  curl --silent --show-error --output /dev/null \
    --write-out 'HTTP %{http_code}\nWWW-Authenticate: %header{www-authenticate}\n' \
    --header 'Authorization: Bearer nook-invalid' \
    "https://<hostname>/$path"
done
```

Access must block these requests (a redirect, denial, or Managed OAuth discovery challenge); `/api/machines` must not produce a Worker 404. Confirm `/` and `/mcp` still require Access in a fresh browser. These captures verify path precedence and the assumption that Managed OAuth intercepts foreign Bearers. If inspecting whether Bypass forwards an assertion through trusted Cloudflare tooling, retain only a presence/absence boolean, never the header value. Its absence remains an assumption until observed; Nook exposes no debug endpoint for it.

Finally, run login, whoami, and logout on the owner's Omarchy machine against production. Capture the approval page, successful identity, and logout. Record E1/E6 behavior and E25 outcomes on the PR without tokens, cookies, JWTs, device codes, keyring contents, or configured secrets. Local tests do not claim these production captures.

## Connect a machine with limited bucket access

After login and approval, connect clients to `https://<hostname>/api/machine/mcp`. The existing `api/machine/*` Bypass covers this path; no additional Access application is needed. This endpoint accepts only Nook tokens. The owner's `/mcp` still uses Access and never accepts a Nook token, even with all-bucket access. The machine endpoint also rejects foreign Origin headers.

`nook mcp-header` reads the keyring locally and emits a single headers JSON line for a client to consume. It does not contact the server or save a credential file. Use it only as a client helper; its stdout contains the credential and must not be captured in a terminal transcript, log, or agent conversation. If there is no usable session, it emits no stdout and gives login guidance on stderr. A stalled keyring lookup is stopped after 5 seconds, leaving time to report the failure before the client's helper deadline. `whoami` displays its grant without a credential. Each authenticated MCP request updates the machine's last use, and web revocation makes the next request unauthorized.

A client may not inherit the shell's `PATH`, so give the helper an absolute path: the mise shim, `~/.local/share/mise/shims/nook` by default, or `/opt/homebrew/bin/nook` from Homebrew. Replace `/absolute/path/to/nook` below with it. Keep the unlocked Secret Service available to the client process.

For Claude Code, add a separate user-scope server:

```sh
claude mcp add-json --scope user nook-limited \
  '{"type":"http","url":"https://<hostname>/api/machine/mcp","headersHelper":"/absolute/path/to/nook mcp-header"}'
```

The helper supplies authentication on connection. See [Claude Code dynamic headers](https://code.claude.com/docs/en/mcp#use-dynamic-headers-for-custom-authentication).

For Codex, add a separate entry in the user configuration:

```toml
[mcp_servers.nook_limited]
url = "https://<hostname>/api/machine/mcp"
http_headers_helper = "/absolute/path/to/nook mcp-header"
```

Use the helper as this server's credential source and remove any explicit bearer or stored OAuth credentials for the same entry, which take precedence. This helper works for local HTTP MCP connections. See [Codex HTTP MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

### E23: owner capture after deployment (pending)

The owner performs this capture after the PR is merged and its green-main deployment completes. Automated tests reproduce both observed protocols with synthetic credentials; they do not claim this production check.

1. On the owner's machine, run login against production and approve a limited grant, for example `work/acme`. Record the approval choice and the credential-free `whoami` output.
2. Configure the Claude Code user-scope entry above, open a fresh session, and confirm the server connects. Ask it to call `list_buckets` on `nook-limited`. For that example grant, verify only `me`, `work`, `work/acme`, and its existing descendants appear; siblings and `personal` must be absent.
3. Configure Codex's `http_headers_helper` entry above, start a fresh local session, and repeat `list_buckets` with the same visible set.
4. Record both client versions, connection outcomes, selected roots, and visible bucket paths on the PR. Screenshots must exclude helper output, headers, tokens, token hashes, cookies, JWTs, device codes, and keyring contents. Leave E23 pending until both client outcomes are recorded.
