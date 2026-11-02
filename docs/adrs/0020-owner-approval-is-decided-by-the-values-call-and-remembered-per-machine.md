# ADR-0020: Owner approval is decided by the values call and remembered per machine

Date: 2026-11-02
Status: Accepted

## Context

Under [ADR-0005](0005-vault-level-one-injects-agent-readable-secrets.md), a bucket grant is the approval: an agent on an approved machine uses any secret in its grant, and audit supports review, not prevention. The owner wants to mark chosen buckets or secrets as "ask first", so that a `nook run` that needs them waits for the owner's approval from another device ([#82](https://github.com/taecontrol/nook/issues/82)).

Spikes on 2026-11-02 showed three things:
- Claude Code and Codex keep a blocking command alive and show its stderr. Claude Code moves the command to the background at its tool timeout instead of killing it, and sends SIGTERM when the agent cancels.
- The agent session markers (`CLAUDE_CODE_SESSION_ID`, `CODEX_SESSION_ID`) are claimed by the client, can be forged, and are inherited by nested agents. [ADR-0019](0019-agent-session-claims-are-unverified-audit-annotations.md) makes the one claim the CLI resolves an unverified audit annotation that never scopes approvals.
- Web Push works from workerd, but it requires a PWA and VAPID configuration, and on iPhone the app must be installed on the home screen.

The server verifies only the machine, through its Nook token, and the secret paths requested. Agents can delete empty buckets ([ADR-0008](0008-delete-empty-buckets-to-correct-mistakes.md)). Released CLIs print "Could not reach … Try again" for error tags they do not know.

## Decision

The owner can mark a bucket, which covers its whole subtree, or a single secret. Marks are stored by path in their own table, so they survive bucket deletion. Only the owner sets marks, through routes protected by Access. No MCP tool and no machine route can read or write them.

`POST /api/machine/secrets/values` remains the only place that decides whether a value leaves.

- The grant check runs first and is unchanged.
- A request whose secrets no mark covers is answered as today.
- For covered secrets, the call answers in one of three ways: the values, a pending answer with an approval URL, or a final error. The CLI waits by sending the same request again under one attempt id for up to 10 minutes. It prints the URL and the remaining time on stderr, exits 77 on denial and 75 on expiry, and withdraws the request when it receives SIGINT or SIGTERM.
- Delivery writes its audit rows only if the approval and the marks still hold, and returns values only if every row was written.
- A request from a released CLI, which does not send the approval field, gets `VaultNotConfigured` with an update message and no value.

The approval channel is the link alone. The agent relays the URL, and the owner decides in the web app.

The owner chooses one of three approvals:
- *only this time*, which covers that attempt;
- *1 hour* or *12 hours*, which is remembered. A remembered approval covers later runs on the same machine that need only secrets among the approved ones, whichever agent runs them. The agent session does not scope it, as ADR-0019 requires; the request stores the reported claim only to show it to the owner.

A remembered approval cannot be ended early. The executable, working directory, and agent session are shown to the owner but do not bind the approval. The purpose is labelled unverified.

[docs/design/owner-approval.md](../design/owner-approval.md) holds the contracts, states, and validation obligations until implementation transfers them to code and tests.

## Consequences

The owner can prevent a use, not only review it, on the secrets that matter. Unmarked secrets keep today's behavior and latency. Every request, decision, withdrawal, and delivery under an approval is audited.

What the owner accepts:
- A remembered approval covers every agent on that machine for its window. The owner chose this over binding it to the reported session (2026-11-02). Approval protects against careless use, not against an agent that deliberately extracts a value; that limit is the same as level 1's.
- Exit codes 75 and 77 can collide with the child command's own codes, so agents read the stderr text too.
- Released CLIs receive a 503 for a policy refusal until the owner updates them.
- Each poll re-reads ciphertexts and updates the token's last-used time.

Approval is only as strong as the owner's Access identity. The owner's MCP clients obtain that identity through Managed OAuth ([ADR-0003](0003-cloudflare-access-for-the-owner-and-nook-tokens-for-machines.md)), so an agent that reads its client's stored OAuth token could approve its own request. The same exposure already exists for reveal and for machine authorization.

## Alternatives considered

- **A separate approval resource** (create, poll, then deliver with an approval id). Rejected because the CLI would orchestrate the stages, and the poll and the values call could disagree after a mark changes.
- **A signed approval token returned to the CLI.** Rejected because the agent can read and replay it, and revoking it needs server state anyway.
- **Holding the request open until the owner decides.** Rejected because the CLI's request timeout is 10 s, the Worker would bear the duration and cost, and a cancelled request would leave no clean way to withdraw it.
- **Marks as columns on `buckets` and `secrets`.** Rejected because an agent could remove a mark by deleting an empty bucket.
- **Web Push or email notifications.** The owner chose the link alone.
- **Failing at once and asking the agent to re-run.** The owner chose to wait.
