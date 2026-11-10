# ADR-0022: `nook run` returns the approval link at once and waits only when resumed

Date: 2026-11-10
Status: Accepted

## Context

[ADR-0021](0021-owner-approval-is-decided-by-the-values-call-and-remembered-per-machine.md) made `nook run` print the approval URL on stderr and wait up to 10 minutes in the same invocation. The agent was expected to relay the URL to the owner while the command waited. That rested on a spike finding that a blocking command's stderr reaches the agent while it runs.

The finding was wrong. An agent receives a command's output when the command ends, or when its tool timeout passes and the harness moves the command to the background. A probe in Claude Code on 2026-11-10 showed nothing until the timeout, which is 2 minutes by default and can be set to 10, the lifetime of the request. In use, the owner marked two secrets as ask first, an agent ran `nook run`, and nobody told the owner: the link sat in output the agent had not yet seen.

The link is still the only channel (ADR-0021), so the agent must hold it before anyone can approve.

## Decision

A `nook run` that receives a pending answer does not wait. It prints the covered paths, the approval URL, the time left, and the attempt id, and exits 75 without withdrawing the request. Its message tells the agent to give the owner the link and to run the same command again with `--approval <attempt id>`.

A run given `--approval` sends that attempt id instead of a new one. It is the run that waits: it re-asks under the attempt until the owner decides or the request expires, exactly as ADR-0021 describes, and it withdraws the request on SIGINT or SIGTERM.

The server does not change. It already answers a repeated request under one attempt id, and it refuses an attempt id reused with a different payload.

Every caller gets the same two steps, including a person at a terminal. The CLI does not guess whether an agent is reading its output.

Messages for an expired, withdrawn, or changed request now say `Run again without --approval to ask again.`, because a finished attempt can never be delivered.

## Consequences

The agent learns about the request as soon as it exists, so the owner hears about it within one tool call.

What the owner accepts:
- An approval takes two commands. An agent that ignores the message and repeats the plain command creates a new request each time; each expires after 10 minutes and counts toward the pending limit.
- *Only this time* still lasts 2 minutes after the decision. An agent that waits for the owner to reply before it resumes can miss that window and must ask again. A remembered approval has no such limit, and a later plain run uses it.
- A request stays pending while no process waits on it. The approval page cannot tell whether the agent has resumed.
- A run given an attempt id the server has never seen creates that request and waits on it, as every run did before this decision.

## Alternatives considered

- **Keep waiting in one invocation.** Rejected: the agent cannot relay a link it has not received.
- **Wait in place when stderr is a terminal, or when no agent session variable is set.** Rejected: some harnesses run commands under a terminal, and an agent the CLI does not recognize would wait silently again.
- **Let the server match a plain second run to the pending request.** Rejected: it changes what *only this time* covers at the delivery boundary, to save the agent one flag.
- **Remember the pending attempt in a local file.** Rejected: it adds state to clean up, and a denied or expired attempt would stick to the command.
- **A notification channel to the owner, such as Web Push or email.** Still out of scope, as in ADR-0021.
