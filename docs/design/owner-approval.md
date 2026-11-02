# Owner approval before `nook run` uses chosen secrets

Status: Accepted (owner, 2026-11-02)
Date: 2026-11-02
Issue: [#82](https://github.com/taecontrol/nook/issues/82), part of [#76](https://github.com/taecontrol/nook/issues/76)
Grounded at: `main` 1927803 (designed at 466b0e6)
Numbering: ADR-0021 and migration `0016_owner_approval.sql`. Recheck migration numbering when integrating with `origin/main`.

## 1. Problem and scope

Today a bucket grant is the approval: an agent on an approved machine uses any secret in its grant without asking the owner ([ADR-0005](../adrs/0005-vault-level-one-injects-agent-readable-secrets.md)). This design lets the owner mark buckets or secrets as **ask first**. A `nook run` that needs a marked secret waits until the owner approves it from another device.

The decision covers the persisted data (marks and approvals), the machine contract that `nook run` uses, the owner contract for approving and marking, and the security boundary between what the server verifies and what the client claims.

Out of scope:
- Push, email, or any other notification channel.
- Approval for MCP tools. MCP never returns values.
- Owner reveal in the web app. It stays as it is today.
- The owner-OAuth exposure described in section 10. It predates this change.

Protected behavior:
- A secret that no mark covers behaves exactly as today: one call, the same response, no extra latency.
- The grant check runs first, and an approval never widens a grant.
- Every delivery is audited before the value is returned.
- A released CLI never receives a covered value.

## 2. Grounding

Spikes run locally on 2026-11-02 (the experiments were deleted afterwards):

- **Claude Code.** A blocking command's stderr reaches the agent while it runs. At the tool timeout, Claude Code moves the command to the background and notifies the agent when it exits, instead of killing it. When the agent cancels, the command receives SIGTERM.
- **Codex 0.166.** It waited 150 s on a blocking command, saw interim output, and did not kill the command.
- **Session markers.** Claude Code sets `CLAUDE_CODE_SESSION_ID`, which stays stable across turns. Codex sets `CODEX_SESSION_ID`. Nested agents inherit both. The values are claimed by the client and an agent can forge them. Since #117, the CLI resolves one claim per run (`apps/cli/src/agent-session.ts`, ADR-0019) and sends it as `RunSecrets.agentSession`.
- **Web Push.** It works end to end from workerd: VAPID signing and aes128gcm encryption through WebCrypto. It was not chosen.
- **Polling cost.** Polling D1 for up to 10 minutes is negligible. The existing `nook login` device flow already prints a URL and polls for 10 minutes (`apps/cli/src/session.ts`).
- **Released CLIs (v0.2.0–v0.3.2).** They print `Could not reach <url>. Try again.` for any unknown error tag. For `VaultNotConfigured` they print the server's message (`apps/cli/src/run.ts` `runFailure`).
- **Bucket deletion.** Agents can delete empty buckets through MCP ([ADR-0008](../adrs/0008-delete-empty-buckets-to-correct-mistakes.md), `mcp.ts`).

The server verifies two facts: the machine, through its Nook token, and the secret paths requested. The client claims the purpose, executable, working directory, and agent session.

## 3. Domain meaning (owner decisions, 2026-11-02)

- **Ask-first mark.** The owner can put a mark on a bucket or on a single secret. A bucket mark covers that bucket and every bucket below it (`work` covers `work/acme`, but not `work2`). A secret that an agent creates inside a marked bucket is covered. Only the owner, in the web app, sets or removes marks.
- **Covered secret.** A requested secret that some mark covers when the server reads the marks.
- **Approval request.** One `nook run` invocation waiting for the owner. It expires after 10 minutes.
- **Approval.** The owner's decision on a request. It is one of three:
  - *only this time*: covers that invocation;
  - *1 hour* or *12 hours*: a remembered approval that covers later runs on the same machine that need only approved secrets, whichever agent runs them. The agent session never scopes an approval (owner decision, 2026-11-02, consistent with ADR-0019).
- **Channel.** `nook run` prints the approval URL, the agent relays it in chat, and the owner decides in the Nook web app. There is no other channel.
- **Shown, not bound.** The approval page shows the executable, the working directory, and the reported agent session, but an approval does not depend on them. The purpose is labelled as an unverified claim.

**Also decided by the owner (2026-11-02):**
- A remembered approval is not bound to the agent session (option B, consistent with ADR-0019 from #117). Any run on the same machine that needs only approved secrets reuses it until it ends.
- "Same secrets" means that a remembered approval also covers a later run that needs *some* of the approved secrets. It never covers a run that needs a secret outside the approved set.
- There is no way to end a remembered approval early. To cut one short, the owner narrows or revokes the machine.
- Visual reference: the `card` direction, polished (section 11).

## 4. Caller usage

**Agent.** The agent runs `nook run -- pnpm deploy`, and `work/acme` is marked:

```
nook: work/acme/STRIPE_KEY needs the owner's approval.
      Ask the owner to open https://nook.example.com/approvals/3f2c…
      Waiting (10:00 left)…
```

- **Approved.** The command runs.
- **Denied.** `The owner denied work/acme/STRIPE_KEY. Nothing was delivered.` Exit code 77.
- **Timeout,** or the server is unreachable until the deadline: `The approval request expired. Run again to ask again.` Exit code 75.
- **Cancelled.** When the agent stops the command (SIGINT or SIGTERM), `nook run` withdraws the request (best effort) and exits with 130 or 143.
- **Remembered.** A later run on the same machine, needing some of the approved secrets, is delivered on its first call and prints nothing extra, whichever agent runs it.
- **Window passed.** If the *only this time* window passes before this attempt receives its values, the next ask fails with `ApprovalExpired` and exits 75.
- **Released CLI.** An old CLI asking for a covered secret prints `work/acme/STRIPE_KEY needs the owner's approval, and this nook version cannot ask. Update nook.` and exits 1.

**Owner.** The owner opens the link on any device. Access protects the page.
- The page shows the machine (verified), each secret together with the mark that covers it, the purpose (*"claimed by the agent, not verified"*), the executable, the working directory, the agent session (as reported, for context only), the client version, and the time left.
- The actions are **Only this time**, **1 hour**, **12 hours**, and **Deny**.
- A request that can no longer be decided shows its state instead: already approved or denied (with the choice), withdrawn by the agent, expired, or *no longer needed* (`settled`).
- An **Approvals** page lists the pending requests, and the active remembered approvals (read-only: machine, secrets, duration, end time).
- On the Vault page, an **Ask first** switch sits on each bucket and secret. An inherited mark shows as "from `work`".

## 5. Architecture shape

**Single decision point.** `POST /api/machine/secrets/values` is the only place that decides whether a value leaves. For covered secrets it answers in one of three ways:
- delivered, with the values;
- pending: `{approval: {id, url, paths, expiresAt, expiresIn, interval}}`, where `paths` are the covered paths and `expiresIn` is computed with D1's clock, so the CLI's deadline does not depend on its own clock;
- a terminal error.

The CLI waits by sending the same request again under the same `attemptId`.

### Machine contract (under `/api/machine/*`, Nook token)

- `RunSecrets` gains an optional `approval: {attemptId}`. Its presence tells the server that the CLI can wait. The reported session travels in the existing `RunSecrets.agentSession` (#117) and is stored on the request for display only.
- The success type of `values` becomes `DeliveredSecrets | ApprovalPending`.
- New errors:
  - `ApprovalDenied` (403);
  - `ApprovalExpired` (410), with reason `expired` or `withdrawn`;
  - `ApprovalLimit` (429), when too many requests are pending.
- `DELETE /api/machine/approvals/:id` withdraws a pending request that belongs to the calling machine. It always returns 204.
- A request without `approval` for a covered secret gets `VaultNotConfigured` with the update message, and the refusal is audited. That tag answers 503, a server-error status for a policy refusal, until old CLIs are gone.

### Owner contract (Access, outside `/api/machine/*`)

- `GET /api/approvals` returns the pending requests and the active approvals.
- `GET /api/ask-first` returns every mark with whether its path still exists (for the Vault page and the orphan list).
- `GET /api/approvals/:id` returns one request.
- `POST /api/approvals/:id/approve {remember: once|1h|12h}` and `POST /api/approvals/:id/deny`.
- Owner errors: `NotFound` (404), `Expired` (410) when the request expired before the decision, and `AlreadyHandled` (409) with `{status, remember}`.
- `PUT` and `DELETE /api/ask-first/:kind/:path`, where kind is `bucket` or `secret`. Both are idempotent.
- The owner's secret list shows which mark covers each secret.

No MCP tool and no machine route reads or writes marks or decisions.

### Data

- `ask_first_marks(kind, path)` is a separate table keyed by path. Deleting a bucket does not remove its mark. A mark on a path that no longer exists stays in force, which fails closed, and the owner UI lists it so the owner can remove it.
- `approval_requests` has one row per attempt, unique on `(machine_id, attempt_id)`. Each row holds:
  - the paths requested and the covered paths;
  - the claimed facts;
  - the reported agent session claim, for display only;
  - `status`: `pending`, `approved`, `denied`, `withdrawn`, or `settled`. `settled` means the attempt received its values without a decision of its own: a remembered approval covered it, or its secrets stopped being covered. Expiry is not a status; it follows from `expires_at` and `valid_until`;
  - `remember`, `expires_at`, `decided_at`, and `valid_until`.
- Rows are cleaned up lazily, one day after the last time that matters (expiry or the end of the approval), as `authorizations` already is.
- The audit log records the new events with the machine, or with the owner's IP and country for owner decisions:
  - the refusal sent to an old CLI;
  - request created, approved, denied, and withdrawn;
  - delivery under an approval, with the approval id.

### Control flow of `values`

1. Validate. Run the grant check, unchanged. A denied secret is audited and returns `SecretsForbidden`.
2. In the same batch that reads the ciphertexts, read the marks that cover the requested paths.
3. No covered paths: deliver as today.
4. Covered paths and no `approval` field: audit the refusal and return `VaultNotConfigured`.
5. Look for the attempt's own row and for a matching remembered approval. A remembered approval matches when it has the same machine, `approved` status, has not expired, and every covered path is in its covered set. The agent session plays no part. *Only this time* matches only its own attempt.
6. Decide:
   - A payload that differs from the attempt's own row is `InvalidRun`.
   - Denied is `ApprovalDenied`; withdrawn is `ApprovalExpired` with reason `withdrawn`. Both are terminal, including after the last mark is removed or another approval matches.
   - If nothing is covered any more, or a remembered approval matches, deliver (this includes an attempt whose own row is `settled`, or approved but past `valid_until`).
   - Otherwise, a pending row past `expires_at`, a settled row, or an approved row past `valid_until` is `ApprovalExpired`.
   - On a match, deliver.
   - If the attempt's own row is pending, return pending.
   - Otherwise, insert the request (bounded per machine and in total) and return pending.
7. Delivery is one batch. It inserts the `delivered` audit rows only `WHERE` the attempt is neither denied nor withdrawn, the approval is still valid, and the marks are unchanged, and returns values only if every row was inserted. A mark change, a narrowed grant, or an attempt withdrawal that commits first wins.

The owner's decision is a conditional `UPDATE … WHERE status='pending' AND expires_at > now`, with its audit row in the same batch. The first decision wins. Repeating the same approval succeeds only while `valid_until > now`; at or after that boundary it gets `AlreadyHandled {status, remember}`. Repeating a denial succeeds. A different decision gets `AlreadyHandled {status, remember}`.

**Agent session.** The approval logic ignores it. The claim that #117 resolves is stored on the request and shown to the owner as unverified context (ADR-0019).

**Only this time.** The approval stays valid for its own attempt until 2 minutes after the decision, so a retry after a lost response is delivered again and audited again. After that it is `ApprovalExpired`.

### Invariants and owners

| Invariant | Owner |
|---|---|
| Grant check before any approval logic; approval never widens a grant | `run-secrets.ts` ordering |
| No covered value without a valid approval at delivery time | coverage rule in the approvals store, re-asserted in the delivery batch |
| Unmarked requests unchanged | marks read in the existing batch; no covered path takes today's path |
| Only the owner marks and decides | owner routes behind Access; no MCP tool or machine route |
| Agents cannot remove a mark by deleting a bucket | marks keyed by path in their own table |
| No value in approval rows, owner types, audit, logs, or errors | schemas have no value field |
| Released CLIs never receive a covered value | the server refuses requests without `approval` |
| Pending requests are bounded and expire | the insert guard, `expires_at`, lazy cleanup |

## 6. What each boundary hides

- **`run-secrets.ts` and the approvals store.**
  - It hides the inheritance of marks, remembered-approval matching, the windows for *only this time*, limits, cleanup, and the legacy refusal.
  - The handler sees only delivered, pending, or a typed error.
- **`ask-first` store.**
  - It hides how marks are stored. The coverage rule itself is one pure function in the contract (`coveringMark`), used by the Worker and the web; delivery re-checks that the mark set is unchanged in its guarded batch. A failed guard answers a retryable `ServiceUnavailable`, and the waiting CLI re-asks under the same attempt.
- **CLI approval wait.**
  - It hides the re-ask loop, the deadline, transient retries, the stderr pacing, and withdrawal on a signal.
  - `run.ts` sees values, denied, expired, or cancelled.
- **Web approvals.**
  - The link is the cold-open path. The detail is preloaded on intent from the list.
  - Mark toggles are optimistic. Decisions are not, because their outcome depends on the server (expired, or already handled).

## 7. Alternatives and tradeoffs

- **Chosen: approval as an outcome of `values`, re-asked under one attempt id.** The server re-evaluates marks, grants, and remembered approvals on every ask. Costs:
  - `values` has a union success type;
  - every poll re-reads the ciphertexts;
  - the audit log grows new event kinds.
- **A separate approval resource** (create, poll, then deliver with an approval id). It lost because the CLI orchestrates four stages, and the poll and `values` can disagree after a mark changes.
- **A signed approval token returned to the CLI.** It lost because the agent can read and replay it, and revoking it needs server state anyway.
- **Holding the request open until a decision** (long poll or a Durable Object). It lost because of the CLI's 10 s request timeout and the Worker's duration and cost, and because a cancel would have no clean way to withdraw.
- **Marks as columns on `buckets` and `secrets`.** It lost because agents delete empty buckets, and the mark would go with the bucket.
- **Web Push or email.** The owner chose link-only. Push needs a PWA, VAPID configuration, and installation on the iPhone home screen. Email needs Email Routing on the domain.
- **Not waiting (fail at once and re-run).** The owner chose waiting. The spikes show that both agents tolerate it.

## 8. Synthesis provenance

- **Arena.** Two candidates and one independent cross-judge.
- **Base: candidate A.** `values` is the single decision point, and marks live in their own table.
- **Grafted from candidate B:**
  - coverage re-asserted in the delivery batch;
  - owner decisions audited with IP and country, and withdrawals audited;
  - the `VaultNotConfigured` update message for released CLIs;
  - remembered coverage limited to the covered paths.
- **Rejected:**
  - B's marks as columns, because they contradict owner decision 4;
  - B's re-request limit;
  - B's version guard on unmarking;
  - A's `SecretsForbidden` for released CLIs, because its wording sends agents toward widening the grant.
- **Ties I resolved:**
  - the message for released CLIs;
  - remembered coverage limited to the covered paths;
  - *only this time* bound to the attempt, with a 2-minute window.

## 9. Implementation contract

**Must preserve:**
- everything in sections 3 to 5;
- the order of the grant check;
- the guarded delivery batch;
- marks in their own table, keyed by path;
- the agent session never affects matching;
- refusing a request without `approval`;
- exit codes 75 (expired) and 77 (denied);
- the 10-minute expiry;
- the three remember options.

**Free to choose:**
- table and column names, and whether approval events go into `audit_entries` (rebuilt as in migration 0013) or into a table of their own, as long as the audit page shows them and a Worker running during a migration keeps working;
- the poll interval, from 2 s up;
- the limits on pending requests;
- the stderr wording and pacing;
- the web layout, built from shadcn/ui.

**Validation obligations:**
- deny outside the grant for `values` with a covered secret, with no request row created;
- narrowing the grant after a 1-hour approval is refused;
- withdrawing another machine's request is a no-op;
- a Nook Bearer is rejected on `/api/approvals*` and `/api/ask-first*`;
- end to end: a marked secret is requested, approved, and delivered, and the audit shows the request, the decision, and the delivery with its approval id;
- a remembered approval is reused by a later attempt from any agent session on the same machine, and refused for another machine, a secret outside the set, and after its window;
- deleting an empty marked bucket and recreating it keeps the mark;
- the pending-request limit returns `ApprovalLimit`;
- a payload fixture from the latest released CLI (v0.3.2 today) gets the update message and no value;
- unmarked responses are unchanged;
- a table-driven test of the decision covers:
  - lost responses;
  - concurrent decisions;
  - a mark change racing delivery;
  - a mark added or removed while the CLI waits;
  - sibling prefixes (`work/acme` does not cover `work/acme2`);
- CLI tests with a fake server and TestClock check the exit codes, the stderr text, and the `DELETE` sent on SIGTERM, and scrub the real `CLAUDE_CODE_SESSION_ID` and `CODEX_SESSION_ID`;
- a browser acceptance test of the approval page checks the unverified label and the expired, withdrawn, and already-handled states.

**Re-enter design if:**
- the server cannot re-assert coverage atomically with the audit insert;
- Access cannot protect `/approvals/*` like the other owner routes;
- the owner changes a decision in section 3.

## 10. Open risks

- **Owner-OAuth MCP can reach owner routes (predates this change).**
  - `auth.ts` accepts any valid Access assertion for the owner's email, and Managed OAuth gives MCP clients that same assertion.
  - An agent that reads its MCP client's stored OAuth token could therefore:
    - approve its own request;
    - toggle marks;
    - use `reveal`;
    - approve a new machine.
  - Possible mitigation: a second Access application without Managed OAuth on the approval, mark, reveal, and authorization routes, with an AUD of its own. It needs a spike against real Access and its own ADR.
  - The owner decided on 2026-11-02 not to act on it now.
- **Shared reuse on the machine.** The owner accepted that a remembered approval covers every run on that machine that needs only approved secrets, whichever agent runs it. The purpose remains a forgeable claim.
- **Exit code collisions.** 75 and 77 can collide with the child command's own codes, so agents should read the stderr text too.
- **Approval fatigue, and fake URLs relayed by an agent.** These are mitigated by Access on the owner's hostname and by a page that leads with the machine and the secrets.
- **Write churn.** Each poll updates `last_used_at` on the machine token. It is cheap but noisy.

## 11. Visual reference

The owner chose the `card` direction ("Read down, pick, approve"), polished, on 2026-11-02, with one change: no End button and no confirmation for it; the active approvals list is read-only. The reference screenshots live in `docs/design/owner-approval-ui/` and cover every scenario at 390×844 (light), plus dark and 1440×900 for the main screens. Implementation matches their structure, hierarchy, and copy, using the app's real components; pixel parity is not required.

## Slice 1 implementation notes

The contract exports the duration as `ApprovalRemember` because `Remember`
already names the memory creation payload. The approvals module keeps its
local `Remember` name.

A capable run reads its own attempt in the existing ciphertext/marks batch,
including when no mark remains. This preserves payload equality and terminal
denials or withdrawals after the last mark is removed; skipping all approval
reads on that path would bypass these checks. There is no additional round
trip or approval row for a new unmarked run. Successful unmarked or remembered
delivery settles a pending attempt in the delivery batch, after the guarded
audit insert.
