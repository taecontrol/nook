# ADR-0019: Agent session claims are unverified audit annotations

Date: 2026-11-02
Status: Accepted

## Context

Several agents can use Vault from the same machine and directory. Machine,
working directory, executable and purpose do not identify their sessions.
Agent harnesses expose session identifiers in the command environment, but
any caller that controls that environment can choose any identifier. Nested
harnesses can also leave several identifiers in one environment.

Keeping every reported identifier would preserve nesting and allow later
reinterpretation, at the cost of a separate collection and read-time rules.
The owner chose one claim per entry for everyday review and session filtering.

## Decision

Treat the agent session as an unverified audit annotation on CLI Vault uses,
grant denials and creations. Never use it for authorization or to scope
approvals, including the approvals planned in [#82](https://github.com/taecontrol/nook/issues/82).
Bucket grants remain the authorization boundary established in
[ADR-0002](0002-buckets-as-the-authorization-boundary.md).

Keep one claim per entry with fixed precedence: Declared → Codex → Claude
Code → Cursor. A deliberately declared session wins over inherited harness
identifiers; otherwise Codex wins over Claude Code, then Cursor. A Codex
claim may include a distinct thread within the session. Invalid claim content
is discarded without blocking the Vault operation. Claims never contain
secret values, and their environment names are reserved against secret
injection so nested commands cannot mistake a secret for a session.

## Consequences

The owner can group reported activity across directories and distinguish
Codex threads without adding another identity or authorization system. Audit
labels the claim as reported and states that Nook does not verify it. Older
clients, web reveals and memory file activity have no claim.

Nested identifiers beyond the selected claim are lost. Precedence is fixed
by each CLI release and historical entries keep that choice. Filtering matches
the session string across agents and threads: deliberately reusing a declared
name can group unrelated commands. Harness environment variables can change
without notice, leaving future commands without a claim until the CLI is
updated. None of these annotations establishes who is authorized to act.
