# ADR-0018: Vault level 2 waits, and will substitute HTTP credentials in the Worker

Date: 2026-11-02
Status: Accepted

## Context

[ADR-0005](0005-vault-level-one-injects-agent-readable-secrets.md) accepts
that an agent can read every value delivered to a command it starts, so a
prompt-injected agent can exfiltrate any secret its grant covers. It left a
level 2, which keeps HTTP credentials out of the agent's reach, to its own
ADR after spikes ([issue #83](https://github.com/taecontrol/nook/issues/83)).
The owner reports no incident; the work is preventive
([issue #76](https://github.com/taecontrol/nook/issues/76)).

Local spikes on 2026-11-02 established:

- **Anything delivered through the CLI is level 1.** The agent runs as
  the owner's user, so it can use the CLI's machine token from the keyring
  and run `nook run` itself. A same-user process's environment was readable
  through `/proc/<pid>/environ`. Its memory was not, under
  `ptrace_scope=1`, but that does not matter while the token is reachable.
  A secret stays out of the agent's reach only if its value stays outside
  the agent's trust domain: under another user or host, or in Cloudflare.
- **The Worker can substitute.** A prototype in local workerd replaced a
  placeholder with the value in `Authorization` (Bearer and Basic),
  custom headers and query parameters. It refused other destinations,
  other methods and expired placeholders, and streamed server-sent events
  without delay. A command that bypassed it sent only the placeholder.
- **Intercepting TLS on the machine is costly.** No single variable makes
  every tool trust a per-command CA: curl, Go and Python's `urllib` read
  `SSL_CERT_FILE`, Node needs `NODE_EXTRA_CA_CERTS`, and `requests` needs
  `REQUESTS_CA_BUNDLE`. A substituting proxy on the machine also needs
  another user or root to hold the value, and an egress sandbox around the
  agent that Nook does not control. `bwrap --unshare-net` isolates one
  command, not the agent.
- **Substitution has limits.** The tool must accept a different base
  URL: the OpenAI and Anthropic SDKs document one, while `gh` accepts only a
  host and appends `/api/v3`. A destination that echoes request headers
  returns the value to the agent. Non-HTTP protocols and secrets an
  application needs at runtime fall outside the model, and a private
  destination needs a path from Cloudflare to it. The spikes did not
  validate credentials in request bodies or client-side signatures such as
  AWS SigV4; the Claude Code sandbox re-signs SigV4, so they need more
  mechanism rather than being impossible.

## Decision

Nook does not build level 2 now. Level 1 stays as ADR-0005 describes, and
Nook records no per-secret destination metadata until level 2 is built,
because metadata that nothing enforces protects nothing and its shape
depends on the proxy.

When the owner decides a concrete secret justifies it, level 2 takes this
shape: the Nook Worker is the substituting proxy, because Cloudflare is
already outside the agent's trust domain and needs nothing installed on the
machine. Nook never exposes the value of a secret placed behind it through
an interface an agent can reach, including `nook run`. The command receives a placeholder and a proxy base URL instead,
and the Worker substitutes the value only for destinations the owner
approved and only until the placeholder expires. Whether the owner can
still reveal such a value in the web app, and which request locations and
signing schemes are supported, are left to that work.

## Consequences

Nothing changes for agents or the owner now. A prompt-injected agent can
still exfiltrate any secret its grant covers; bucket grants and
development-scoped credentials remain the limit.

Future level 2 work starts from settled ground: substitution happens in
Cloudflare, no local CA, privileged service or egress sandbox is needed,
and placing a secret behind the proxy means giving up `nook run` delivery
for it. That work still has to verify in production whether destination
APIs accept Cloudflare's egress addresses, how host-only tools such as `gh`
reach the proxy, and how far a destination that echoes headers can be
contained. An agent behind the proxy can still use the credential against
an approved destination until the placeholder expires. It no longer
receives the value from Nook, but preventing extraction through an approved
destination remains an open requirement.

## Alternatives considered

- **A proxy on the machine under the owner's user:** rejected because the
  agent can read the value from it, or fetch the value with the same token.
- **A proxy under another user or root with TLS interception:** rejected
  because it needs a privileged install on every machine, per-tool CA
  trust, and egress control over an agent Nook does not start.
- **The Claude Code sandbox credential `mask` mode:** not adopted as Nook's
  design because it serves only Claude Code, and the agent's unsandboxed
  tools keep access to the value. An owner can still use it alongside Nook.
- **Recording allowed destinations per secret now:** rejected for the
  reason in the decision.
