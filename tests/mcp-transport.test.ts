import { expect, it } from 'vitest';
import { access, accessFixture } from './support/access.ts';
import {
  expectToolSuccess,
  type McpVersion,
  mcpDriver,
} from './support/mcp.ts';
import { runtime } from './support/runtime.ts';

async function freshRequest(
  version: McpVersion,
  method: string,
  params?: Record<string, unknown>,
) {
  const issuer = await accessFixture();
  const app = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  try {
    const driver = mcpDriver(app.origin, version, {
      'Cf-Access-Jwt-Assertion': await issuer.assertion(),
    });
    if (method.startsWith('notifications/')) {
      const response = await driver.request(method, params);
      expect(response.status).toBe(202);
      expect(response.headers.has('Mcp-Session-Id')).toBe(false);
      expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
      expect(await response.text()).toBe('');
      return;
    }
    return await driver.result<Record<string, unknown>>(method, params);
  } finally {
    await app.close();
  }
}
it('E8a: Claude discovery, tool list and call work without initialization or session state', async () => {
  const issuer = await accessFixture();
  const app = await runtime({
    bindings: access,
    outboundService: issuer.outboundService,
  });
  try {
    const driver = mcpDriver(app.origin, '2026-07-28', {
      'Cf-Access-Jwt-Assertion': await issuer.assertion(),
    });
    const discovery = await driver.result('server/discover');
    expect(discovery).toMatchObject({
      supportedVersions: ['2026-07-28'],
      capabilities: { tools: {} },
    });
    expect(discovery).not.toHaveProperty('instructions');
    expect((await driver.listTools()).tools).toHaveLength(3);
    const result = await driver.call('list_buckets');
    expect(result.isError).not.toBe(true);
    expect(result.structuredContent).toMatchObject({
      buckets: [{ path: 'me' }],
    });
    expect(driver.requests).toHaveLength(3);
    expect(
      driver.requests.every(
        (request) =>
          request.method === 'POST' && !request.headers.has('Mcp-Session-Id'),
      ),
    ).toBe(true);
  } finally {
    await app.close();
  }
});
it('E8b: Codex initialization, notification, list and call each succeed in a fresh isolate', async () => {
  const initialized = await freshRequest('2025-06-18', 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: { elicitation: { form: {}, url: {} } },
    clientInfo: {
      name: 'codex-mcp-client',
      title: 'Codex',
      version: '0.160.0',
    },
  });
  expect(initialized).toMatchObject({
    protocolVersion: '2025-06-18',
    capabilities: { tools: {} },
  });
  expect(initialized).not.toHaveProperty('instructions');
  await freshRequest('2025-06-18', 'notifications/initialized');
  expect(
    await freshRequest('2025-06-18', 'tools/list', {
      _meta: { progressToken: 0 },
    }),
  ).toMatchObject({
    tools: expect.arrayContaining([
      expect.objectContaining({ name: 'list_buckets' }),
    ]),
  });
  const result = await freshRequest('2025-06-18', 'tools/call', {
    name: 'list_buckets',
    arguments: {},
  });
  expect(result).toMatchObject({
    structuredContent: { buckets: [{ path: 'me' }] },
  });
  expect(result?.isError).not.toBe(true);
});
it('E8c: a Codex tool call as the first request needs no session or GET stream', async () => {
  const result = await freshRequest('2025-06-18', 'tools/call', {
    name: 'create_bucket',
    arguments: { path: 'work/acme' },
  });
  expectToolSuccess(result as import('./support/mcp.ts').ToolResult, {
    path: 'work/acme',
    created: true,
    createdAncestors: ['work'],
  });
});
it('E9: the synthetic owner accepts absent/same Origin and rejects a foreign Origin', async () => {
  const app = await runtime();
  try {
    await app.setBindings({
      LOCAL_OWNER: 'synthetic-owner',
      LOCAL_ORIGIN: app.origin,
    });
    for (const headers of [
      {} as Record<string, string>,
      { Origin: app.origin },
    ])
      expect(
        (await mcpDriver(app.origin, '2026-07-28', headers).listTools()).tools,
      ).toHaveLength(3);
    const response = await mcpDriver(app.origin, '2026-07-28', {
      Origin: 'https://foreign.test',
    }).request('tools/list');
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ _tag: 'Unauthorized' });
    expect(response.headers.has('Access-Control-Allow-Origin')).toBe(false);
  } finally {
    await app.close();
  }
});
