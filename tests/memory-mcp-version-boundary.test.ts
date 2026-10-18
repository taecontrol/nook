import { expect, it } from 'vitest';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
} from './support/memory.ts';

it('Memory MCP preserves advertised version schemas and distinct missing-version messages', async () => {
  const app = await memoryRuntime();
  try {
    await seedMemories(app, [memoryFixture(1)]);
    const client = memoryClient(app, '2026-07-28');
    const tools = (await client.listTools()).tools;
    const schemas = ['update', 'forget'].map(
      (name) => tools.find((tool) => tool.name === name)?.inputSchema,
    );
    expect(JSON.stringify(schemas)).toMatchInlineSnapshot(
      `"[{"type":"object","properties":{"id":{"type":"string"},"expectedVersion":{"anyOf":[{"type":"number"},{"type":"string","enum":["Infinity","-Infinity","NaN"]}]},"content":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"workingDirectory":{"type":"string"}},"required":["id","expectedVersion","content"],"additionalProperties":true},{"type":"object","properties":{"id":{"type":"string"},"expectedVersion":{"type":"number"}},"required":["id","expectedVersion"],"additionalProperties":true}]"`,
    );
    const update = await client.call('update', {
      id: memoryId(1),
      content: 'Synthetic replacement.',
    });
    const forget = await client.call('forget', { id: memoryId(1) });
    expect(update.isError).toBe(true);
    expect(forget.isError).toBe(true);
    expect([update.content, forget.content]).toMatchInlineSnapshot(`
      [
        [
          {
            "text": "Input validation error: Invalid arguments for tool update: expectedVersion: Missing key",
            "type": "text",
          },
        ],
        [
          {
            "text": "Use a positive integer for expectedVersion.",
            "type": "text",
          },
        ],
      ]
    `);
  } finally {
    await app.close();
  }
});
