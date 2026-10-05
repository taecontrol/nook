# Deployment configuration

Each installation belongs to one owner in their Cloudflare account. Account IDs, hostnames, Access settings, and credentials stay outside source. `wrangler.jsonc` disables `workers.dev` and preview URLs. Static documents and assets are served by the asset layer; Cloudflare Access must protect the entire hostname, including those paths.

The installation owner supplies the following settings:

| Name | Destination | Source |
| --- | --- | --- |
| `CLOUDFLARE_ACCOUNT_ID` | GitHub repository **Settings → Secrets and variables → Actions → Variables** | Cloudflare **Workers & Pages → Account Details → Account ID**, or dashboard search **Copy account ID**. |
| `NOOK_HOSTNAME` | The same GitHub repository variables | The installation's hostname, without scheme or path. Its DNS zone must be active in the chosen Cloudflare account. |
| `CLOUDFLARE_API_TOKEN` | GitHub repository **Settings → Secrets and variables → Actions → Secrets** | Create an account API token from the **Edit Cloudflare Workers** permission template, scoped to this account and the hostname's zone. Include **Account → D1 → Edit** so deployment can create the database and apply migrations. Initial creation requires the Workers product **Admin** role; an **Editor** can maintain an existing Worker. Changing a custom domain also needs **Zone → Workers Routes → Write** for that zone. |
| `ACCESS_ISSUER` | Worker **nook → Settings → Variables and Secrets**, type **Secret** | `https://<team-name>.cloudflareaccess.com`, with no trailing slash. Find the team name under **Zero Trust → Settings**. |
| `ACCESS_AUDIENCE` | The same Worker secrets | **Zero Trust → Access controls → Applications → the Nook application → Configure → Additional settings → Application Audience (AUD) Tag**. |
| `OWNER_EMAIL` | The same Worker secrets | The exact email the owner's identity provider supplies to Access; use the same identity in the application's Allow policy. |

Never paste secret values into an agent conversation, commit them, or put them in command arguments or logs. Set them directly through their dashboards. No local secret file is necessary.

Before the first deployment, create a self-hosted Access application with a public hostname matching the installation's entire hostname, with the path left empty. Choose the owner's identity provider and an Allow policy for the owner's email. Avoid a narrower path application or a bypass policy, because the static shell and hashed assets rely on Access at the edge. The full Access provisioning guide belongs to the installation work.

Every push to `main` deploys itself. When **Verify** succeeds on a `main` push, the Deploy workflow starts for that exact commit. It deploys only while `main` still points to that commit; when a later merge has moved `main`, it skips, because the later commit's own run deploys it. It checks the commit's successful Verify run, builds the product from that commit, and only then deploys using the repository settings. An installation without the `NOOK_HOSTNAME` variable, such as a fork that is not configured yet, skips automatic deployment. To redeploy by hand, use **Actions → Deploy → Run workflow** and select **main**; dispatches on other branches skip the deployment job.

The workflow creates the `nook` D1 database when missing, applies its migrations, and then deploys the Worker and custom domain. Its binding resolves by database name; no database ID is committed. If the Worker did not already exist, add its three Access secrets through the Worker settings afterwards and apply the secret changes there. Until all three exist, every Worker request returns 401. Later workflow deployments preserve those secrets. The owner can also provision the Worker secrets beforehand through their own Cloudflare administration.

Complete production acceptance by recording a successful main deployment. In a fresh signed-out browser, confirm that `/`, a real hashed JavaScript asset, `/api/whoami`, and `/mcp` redirect to Access or are denied; none may serve the app or asset. Then sign in as the owner and capture the shell showing that identity. Retain outcomes and screenshots without cookies, JWTs, or secret values.

Sources: [Access application](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/self-hosted-public-app/), [account ID](https://developers.cloudflare.com/fundamentals/account/find-account-and-zone-ids/), [CI authentication](https://developers.cloudflare.com/workers/ci-cd/external-cicd/github-actions/), [Worker permissions](https://developers.cloudflare.com/workers/authorization/workers/), [Access audience and issuer](https://developers.cloudflare.com/cloudflare-one/access-controls/applications/http-apps/authorization-cookie/validating-json/), [Worker secrets](https://developers.cloudflare.com/workers/configuration/secrets/).

For bucket acceptance after this change merges, add **Account → D1 → Edit** to `CLOUDFLARE_API_TOKEN` in the Cloudflare token dashboard. Merging deploys automatically once Verify passes on `main`. Sign in as the owner, confirm `GET /api/buckets` lists `me`, create a bucket in the outline, and record the result on the pull request. Do not share the token or Access assertion.

## Remote MCP and Access Managed OAuth

Nook serves `list_buckets`, `create_bucket`, and `delete_bucket` at `https://<hostname>/mcp`. The owner authenticates through the existing Access application with access to the whole bucket tree. The Worker verifies the forwarded Access assertion before MCP. Machine tokens and restricted production grants are future work.

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
