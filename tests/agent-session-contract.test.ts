import { expect, it } from 'vitest';
import * as contract from '../packages/contract/src/index.ts';
import { codexClaim, codexSession } from './support/agent-session.ts';

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
