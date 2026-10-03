# ADR-0005: Vault level 1 injects secrets that the agent can read

Date: 2026-10-03
Status: Accepted

## Context

Agents ask the owner for secrets, and the owner copies them into the conversation by hand. The owner wants agents to find a secret by name and use it, easily and safely.

An agent with a shell running as the owner's user can read any value delivered to a process it starts. 1Password's documentation, which applies here, says: "assume that processes on your computer can access the environment of other processes run by the same user" ([1Password CLI environment variables](https://www.1password.dev/cli/secrets-environment-variables)). It also notes that `op run` masks only exact matches on its own output and can be disabled with `--no-masking`.

Keeping the value out of the agent's reach requires the secret to live in another trust domain and be substituted at the network layer. Two existing examples are the Claude Code sandbox credential `mask` mode ([Claude Code sandboxing](https://code.claude.com/docs/en/sandboxing)) and a broker under another user or host. That works only for HTTP-style credentials. Secrets that the owner's application needs at runtime, such as a dev server started by the agent, stay readable by design. That stronger design also needs spikes whose answers are not documented.

## Decision

Level 1 delivers values into the environment of a command started by `nook run`, never into the conversation. The agent discovers secrets by name through MCP and never receives values from it. Every use requires a stated purpose, recorded in an audit log together with the secret, machine, working directory, executable, and time. Within its granted buckets, an agent may create new secrets but not overwrite or delete existing ones. The owner can reveal a value in the web app, and that is audited too.

Level 1 protects against accidental exposure, such as pasting into chats, plaintext files, and transcripts. It does not protect against an agent that deliberately extracts a value. A later level 2, decided by its own ADR after spikes, may move HTTP credentials out of the agent's reach.

## Consequences

Agents stop asking for secrets, values stay out of conversations, transcripts, and repositories, and the owner can review every use.

A prompt-injected or careless agent can still print or send any secret its token grants. Bucket grants ([ADR-0002](0002-buckets-as-the-authorization-boundary.md)) and development-scoped credentials are what limit the damage. The audit log records stated purposes, which agents can misstate. It supports review, not prevention.

## Alternatives considered

- **An MCP tool that returns secret values:** rejected because the value would enter the model's context and the transcript.
- **Starting with the Claude Code `mask` mode or a broker:** postponed because they cover only HTTP credentials, depend on unverified behavior, and do not help with application runtime secrets.
