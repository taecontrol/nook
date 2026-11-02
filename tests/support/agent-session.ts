import { createServer } from 'node:http';
import type { TestRuntime } from './runtime.ts';

export const claudeSession = '78f82c41-1f68-47b1-9372-0d929da0da78';
export const codexSession = '0199f3c2-7a10-7d4e-9b1a-3f2e8c1d0a11';
export const codexThread = '0199f3c4-7a10-7d4e-9b1a-3f2e8c1d0e01';
export const cursorSession = 'bc-fix-auth-0199f3c2-7a10-7d4e-9b1a-3f2e8c1d0a11';
export const codexClaim = {
  agent: 'codex',
  session: codexSession,
  thread: codexThread,
};
export const claimNames = [
  'NOOK_AGENT_SESSION',
  'CODEX_SESSION_ID',
  'CODEX_THREAD_ID',
  'CLAUDE_CODE_SESSION_ID',
  'CURSOR_CONVERSATION_ID',
] as const;
export const decoys = {
  CLAUDE_CODE_MESSAGING_TOKEN: 'synthetic-messaging-decoy-81',
  CURSOR_ASKPASS_SECRET: 'synthetic-askpass-decoy-81',
  CODEX_TOOL_CALL_ID: 'synthetic-tool-call-decoy-81',
};

// Observe real HTTP without substituting its behavior or exposing credentials.
export async function sessionTransport(app: TestRuntime) {
  const requests: {
    path: string;
    body: Record<string, unknown>;
    status: number;
  }[] = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks);
    const forwarded = await fetch(app.origin + request.url, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: request.headers.authorization ?? '',
      },
      ...(body.length ? { body } : {}),
    });
    requests.push({
      path: request.url!,
      body: body.length ? JSON.parse(body.toString()) : {},
      status: forwarded.status,
    });
    response.writeHead(forwarded.status, {
      'Content-Type': 'application/json',
    });
    response.end(Buffer.from(await forwarded.arrayBuffer()));
  });
  await new Promise<void>((accept) => server.listen(0, '127.0.0.1', accept));
  const address = server.address();
  if (!address || typeof address === 'string')
    throw new Error('Expected HTTP address.');
  return {
    origin: `http://127.0.0.1:${address.port}`,
    requests,
    close: () =>
      new Promise<void>((accept) => {
        server.closeAllConnections();
        server.close(() => accept());
      }),
  };
}
