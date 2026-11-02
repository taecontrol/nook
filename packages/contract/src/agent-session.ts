import { Schema } from 'effect';

// Reported by the caller's environment, never verified or used for authorization.
export const AgentSessionClaim = Schema.Struct({
  agent: Schema.String,
  session: Schema.String,
  thread: Schema.optionalKey(Schema.String),
});
export type AgentSessionClaim = typeof AgentSessionClaim.Type;

export function isClaimValue(value: string): boolean {
  return (
    value.length >= 1 && value.length <= 200 && !/[^A-Za-z0-9._:~-]/.test(value)
  );
}
function isAgentSlug(agent: string) {
  return agent.length >= 1 && agent.length <= 32 && !/[^a-z0-9-]/.test(agent);
}
export function normalizeAgentSession(
  claim: AgentSessionClaim | undefined,
): AgentSessionClaim | null {
  if (!claim || !isAgentSlug(claim.agent) || !isClaimValue(claim.session))
    return null;
  const thread = claim.thread;
  return {
    agent: claim.agent,
    session: claim.session,
    ...(thread && isClaimValue(thread) && thread !== claim.session
      ? { thread }
      : {}),
  };
}
const agentNames: Readonly<Record<string, string>> = {
  declared: 'Declared',
  codex: 'Codex',
  'claude-code': 'Claude Code',
  cursor: 'Cursor',
};
export function agentLabel(agent: string): string {
  return Object.hasOwn(agentNames, agent) ? agentNames[agent] : agent;
}
