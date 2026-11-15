import { expect, it } from 'vitest';
import {
  claimVariables,
  isClaimVariable,
  resolveAgentSession,
} from '../apps/cli/src/agent-session.ts';
import * as contract from '../packages/contract/src/index.ts';
import {
  claimNames,
  claudeSession,
  codexClaim,
  codexSession,
  codexThread,
  cursorSession,
  decoys,
} from './support/agent-session.ts';

it.each([
  { name: 'absent claim', input: undefined, expected: null },
  { name: 'Codex subagent', input: codexClaim, expected: codexClaim },
  {
    name: 'future agent slug',
    input: { agent: 'future-harness-2', session: 'x' },
    expected: { agent: 'future-harness-2', session: 'x' },
  },
  ...['', 'a b', 'ñ', 'x'.repeat(201), 'x\n', 'x\0'].map((session, index) => ({
    name: `invalid session ${index}`,
    input: { ...codexClaim, session },
    expected: null,
  })),
  ...['', 'Bad', 'a_b', 'a'.repeat(33)].map((agent, index) => ({
    name: `invalid slug ${index}`,
    input: { ...codexClaim, agent },
    expected: null,
  })),
  ...['', 'a b', 'ñ', 'x'.repeat(201), codexSession].map((thread, index) => ({
    name: `discarded thread ${index}`,
    input: { ...codexClaim, thread },
    expected: { agent: 'codex', session: codexSession },
  })),
])('normalization: $name', ({ input, expected }) => {
  expect(contract.normalizeAgentSession(input)).toEqual(expected);
});
it('claim values accept only 1–200 ASCII identifier characters', () => {
  for (const value of ['x', 'A0._:~-z', 'x'.repeat(200)])
    expect(contract.isClaimValue(value)).toBe(true);
  for (const value of ['', 'x'.repeat(201), 'a b', 'ñ', 'x\n'])
    expect(contract.isClaimValue(value)).toBe(false);
});
it('agent labels name known harnesses and preserve unknown slugs', () => {
  expect(
    ['declared', 'codex', 'claude-code', 'cursor', 'future'].map(
      contract.agentLabel,
    ),
  ).toEqual(['Declared', 'Codex', 'Claude Code', 'Cursor', 'future']);
});

const precedence: {
  label: string;
  env: Record<string, string>;
  claim: unknown;
}[] = [
  {
    label: 'E1: Claude Code session',
    env: { CLAUDE_CODE_SESSION_ID: claudeSession },
    claim: { agent: 'claude-code', session: claudeSession },
  },
  {
    label: 'E2: Codex subagent session and thread',
    env: { CODEX_SESSION_ID: codexSession, CODEX_THREAD_ID: codexThread },
    claim: codexClaim,
  },
  {
    label: 'E2: sibling Codex subagent keeps its own thread',
    env: {
      CODEX_SESSION_ID: codexSession,
      CODEX_THREAD_ID: '0199f3c5-7a10-7d4e-9b1a-3f2e8c1d0a12',
    },
    claim: {
      agent: 'codex',
      session: codexSession,
      thread: '0199f3c5-7a10-7d4e-9b1a-3f2e8c1d0a12',
    },
  },
  {
    label: 'E3: legacy Codex thread becomes session',
    env: { CODEX_THREAD_ID: codexThread },
    claim: { agent: 'codex', session: codexThread },
  },
  {
    label: 'E3: root Codex omits redundant thread',
    env: { CODEX_SESSION_ID: codexSession, CODEX_THREAD_ID: codexSession },
    claim: { agent: 'codex', session: codexSession },
  },
  {
    label: 'E4: Cursor conversation',
    env: { CURSOR_CONVERSATION_ID: cursorSession },
    claim: { agent: 'cursor', session: cursorSession },
  },
  {
    label: 'E5: declared wins over inherited harnesses',
    env: {
      NOOK_AGENT_SESSION: 'nightly-backup',
      CODEX_SESSION_ID: codexSession,
      CLAUDE_CODE_SESSION_ID: claudeSession,
      CURSOR_CONVERSATION_ID: cursorSession,
    },
    claim: { agent: 'declared', session: 'nightly-backup' },
  },
  {
    label: 'E5: declared accepts 200 characters',
    env: { NOOK_AGENT_SESSION: 'a'.repeat(200) },
    claim: { agent: 'declared', session: 'a'.repeat(200) },
  },
  {
    label: 'E6: Codex wins over inherited Claude Code',
    env: {
      CODEX_SESSION_ID: codexSession,
      CLAUDE_CODE_SESSION_ID: claudeSession,
    },
    claim: { agent: 'codex', session: codexSession },
  },
  {
    label: 'E7: no harness omits the wire key and reads as null',
    env: {},
    claim: null,
  },
  ...['a b', '秘密', '', 'a'.repeat(201)].map((value, index) => ({
    label: `E8: invalid Claude Code value ${index} falls through silently`,
    env: {
      CLAUDE_CODE_SESSION_ID: value,
      CURSOR_CONVERSATION_ID: cursorSession,
    },
    claim: { agent: 'cursor', session: cursorSession },
  })),
];
it.each(precedence)('CLI resolution $label', ({ env, claim }) => {
  expect(resolveAgentSession((name) => env[name])).toEqual(claim);
});
// The literal names are the user-facing contract, so a name added to or
// dropped from the production list turns this red.
it('the CLI reserves exactly the claim variables', () => {
  expect([...claimVariables].sort()).toEqual([...claimNames].sort());
  for (const name of claimNames) expect(isClaimVariable(name), name).toBe(true);
  for (const name of ['GH_TOKEN', ...Object.keys(decoys)])
    expect(isClaimVariable(name), name).toBe(false);
});
