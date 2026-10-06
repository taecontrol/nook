import { expect } from 'vitest';

export type McpVersion = '2026-07-28' | '2025-06-18';
export type ToolResult = {
  content: { type: string; text: string }[];
  structuredContent?: Record<string, unknown>;
  isError?: boolean;
};
export type ToolList = {
  tools: {
    name: string;
    description: string;
    annotations: Record<string, boolean>;
    inputSchema: Record<string, unknown>;
    outputSchema: Record<string, unknown>;
  }[];
};

// Uses the observed MCP headers and bodies of Claude Code 2.1.289 and Codex 0.160.0.
// Initialization has no version header; Codex does not send Mcp-Method.
export function mcpRequest(
  origin: string,
  version: McpVersion,
  method: string,
  params?: Record<string, unknown>,
  headers: HeadersInit = {},
) {
  const modern = version === '2026-07-28';
  const meta = modern
    ? {
        'io.modelcontextprotocol/protocolVersion': version,
        'io.modelcontextprotocol/clientInfo': {
          name: 'claude-code',
          title: 'Claude Code',
          version: '2.1.289',
        },
        'io.modelcontextprotocol/clientCapabilities': {
          elicitation: { form: {}, url: {} },
        },
      }
    : {};
  return new Request(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      // A denied POST can leave its body unread and workerd closes the socket.
      // Explicit close prevents Node's pool from racing that peer shutdown.
      Connection: 'close',
      Accept: modern
        ? 'application/json, text/event-stream'
        : 'text/event-stream, application/json',
      'Content-Type': 'application/json',
      ...(method === 'initialize' ? {} : { 'MCP-Protocol-Version': version }),
      ...(modern ? { 'Mcp-Method': method } : {}),
      ...(modern && method === 'tools/call' && typeof params?.name === 'string'
        ? { 'Mcp-Name': params.name }
        : {}),
      ...Object.fromEntries(new Headers(headers)),
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      ...(method.startsWith('notifications/') ? {} : { id: 1 }),
      method,
      ...(modern || params
        ? {
            params: {
              ...params,
              ...(modern
                ? { _meta: { ...(params?._meta as object), ...meta } }
                : {}),
            },
          }
        : {}),
    }),
  });
}

export function mcpDriver(
  origin: string,
  version: McpVersion = '2026-07-28',
  headers: HeadersInit = {},
  send: (request: Request) => Promise<Response> = fetch,
) {
  const requests: Request[] = [];
  const request = (method: string, params?: Record<string, unknown>) => {
    const input = mcpRequest(origin, version, method, params, headers);
    requests.push(input);
    return send(input);
  };
  async function result<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const response = await request(method, params);
    expect(response.status, `${method} must reach MCP`).toBe(200);
    expect(response.headers.has('Mcp-Session-Id')).toBe(false);
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
    const text = await response.text();
    const messages = response.headers
      .get('Content-Type')
      ?.includes('text/event-stream')
      ? text
          .split(/\r?\n\r?\n/)
          .map((event) =>
            event
              .split(/\r?\n/)
              .filter((line) => line.startsWith('data:'))
              .map((line) => line.slice(5).trimStart())
              .join('\n'),
          )
          .filter(Boolean)
          .map((data) => JSON.parse(data))
      : [JSON.parse(text)];
    const envelope = messages.find((message) => message.id === 1);
    expect(envelope).toMatchObject({ jsonrpc: '2.0', id: 1 });
    expect(envelope.error).toBeUndefined();
    expect(envelope.result).toBeDefined();
    return envelope.result as T;
  }
  return {
    requests,
    request,
    result,
    listTools: () => result<ToolList>('tools/list'),
    call: (name: string, args: Record<string, unknown> = {}) =>
      result<ToolResult>('tools/call', { name, arguments: args }),
  };
}

export function expectToolSuccess(
  result: ToolResult,
  body: Record<string, unknown>,
) {
  expect(result.isError).not.toBe(true);
  expect(result.structuredContent).toEqual(body);
  expect(result.content).toEqual([
    { type: 'text', text: JSON.stringify(body) },
  ]);
}

export function expectToolError(result: ToolResult, message: string) {
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(result.content).toEqual([{ type: 'text', text: message }]);
}
