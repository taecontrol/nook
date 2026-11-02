import {
  type AgentSessionClaim,
  isClaimValue,
  normalizeAgentSession,
} from '@nook/contract';

export const claimVariables = [
  'NOOK_AGENT_SESSION',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CURSOR_CONVERSATION_ID',
] as const;
type ClaimVariable = (typeof claimVariables)[number];

export function isClaimVariable(name: string): boolean {
  return claimVariables.some((variable) => variable === name);
}
export function resolveAgentSession(
  read: (name: ClaimVariable) => string | undefined,
): AgentSessionClaim | null {
  const valid = (name: ClaimVariable) => {
    const value = read(name);
    return value !== undefined && isClaimValue(value) ? value : undefined;
  };
  const declared = valid('NOOK_AGENT_SESSION');
  if (declared) return { agent: 'declared', session: declared };
  const session = valid('CODEX_SESSION_ID');
  const thread = valid('CODEX_THREAD_ID');
  const codexSession = session ?? thread;
  if (codexSession)
    return normalizeAgentSession({
      agent: 'codex',
      session: codexSession,
      ...(thread ? { thread } : {}),
    });
  const claude = valid('CLAUDE_CODE_SESSION_ID');
  if (claude) return { agent: 'claude-code', session: claude };
  const cursor = valid('CURSOR_CONVERSATION_ID');
  return cursor ? { agent: 'cursor', session: cursor } : null;
}
