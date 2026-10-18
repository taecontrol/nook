import { expect, it } from 'vitest';
import {
  memoryClient,
  memoryFixture,
  memoryId,
  memoryRuntime,
  seedMemories,
} from './support/memory.ts';

it('Memory MCP advertises the same positive integer version schema for update and forget', async () => {
  const app = await memoryRuntime();
  try {
    await seedMemories(app, [memoryFixture(1)]);
    const client = memoryClient(app, '2026-07-28');
    const tools = (await client.listTools()).tools;
    const schemas = ['update', 'forget'].map(
      (name) => tools.find((tool) => tool.name === name)?.inputSchema,
    );
    expect(JSON.stringify(schemas)).toMatchInlineSnapshot(
      `"[{"type":"object","properties":{"id":{"type":"string"},"expectedVersion":{"type":"integer","minimum":1},"content":{"type":"string"},"tags":{"type":"array","items":{"type":"string"}},"workingDirectory":{"type":"string"}},"required":["id","expectedVersion","content"],"additionalProperties":true},{"type":"object","properties":{"id":{"type":"string"},"expectedVersion":{"type":"integer","minimum":1}},"required":["id","expectedVersion"],"additionalProperties":true}]"`,
    );
  } finally {
    await app.close();
  }
});

it('Memory MCP returns the same missing-version message for update and forget', async () => {
  const app = await memoryRuntime();
  try {
    await seedMemories(app, [memoryFixture(1)]);
    const client = memoryClient(app, '2026-07-28');
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
            "text": "Use a positive integer for expectedVersion.",
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
