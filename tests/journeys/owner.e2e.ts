import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { observe } from '../../scripts/observation.ts';
import { spanishRelease } from '../fixtures/search-corpus.ts';
import { privateKeyring } from '../support/cli.ts';

test('Search E22: the owner finds a Spanish release by meaning from an ancestor bucket', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  const origin = JSON.parse(
    await browser.evaluate(() => JSON.stringify(location.origin)),
  ) as string;
  const bucket = await fetch(`${origin}/api/buckets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'work/acme' }),
  });
  if (!bucket.ok)
    throw new Error('The search journey requires its synthetic bucket.');
  const response = await fetch(`${origin}/mcp`, {
    method: 'POST',
    headers: {
      Connection: 'close',
      Accept: 'application/json, text/event-stream',
      'Content-Type': 'application/json',
      'MCP-Protocol-Version': '2026-07-28',
      'Mcp-Method': 'tools/call',
      'Mcp-Name': 'remember',
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: {
        name: 'remember',
        arguments: {
          bucket: 'work',
          content: spanishRelease,
          tags: ['deploy', 'cli'],
        },
        _meta: {
          'io.modelcontextprotocol/protocolVersion': '2026-07-28',
          'io.modelcontextprotocol/clientInfo': {
            name: 'synthetic-journey',
            version: '1',
          },
          'io.modelcontextprotocol/clientCapabilities': {},
        },
      },
    }),
  });
  const body = (await response.json()) as {
    result?: { isError?: boolean; structuredContent?: { id: string } };
  };
  if (
    !response.ok ||
    body.result?.isError ||
    !body.result?.structuredContent?.id
  )
    throw new Error(
      'The real remember tool must store the Spanish journey memory.',
    );
  await screen.getByRole('link', { name: 'Memory', exact: true }).click();
  await browser.locator('[data-path="work/acme"] a').click();
  await screen
    .getByRole('textbox', { name: 'Search memories visible in work/acme' })
    .fill('how do we deploy');
  await screen
    .getByRole('textbox', { name: 'Search memories visible in work/acme' })
    .press('Enter');
  const result = browser.locator(
    `[data-search-result="${body.result.structuredContent.id}"]`,
  );
  await expect(result).toContainText('Proceso de release');
  await expect(result).toContainText('work');
  await expect(result).toContainText('By meaning');
  await result.click();
  await expect(
    screen.getByRole('article', { name: 'Memory detail' }),
  ).toContainText('Para publicar una versión nueva');
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('Memory update E30: the owner reads both writers and compares version 2 after opening version 1', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  const origin = JSON.parse(
    await browser.evaluate(() => JSON.stringify(location.origin)),
  ) as string;
  const bucket = await fetch(`${origin}/api/buckets`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: 'work/memory-journey' }),
  });
  if (!bucket.ok)
    throw new Error('The synthetic memory journey requires its bucket.');
  async function writeMemory(
    name: 'remember' | 'update',
    input: Record<string, unknown>,
    clientVersion: string,
  ) {
    const response = await fetch(`${origin}/mcp`, {
      method: 'POST',
      headers: {
        Connection: 'close',
        Accept: 'application/json, text/event-stream',
        'Content-Type': 'application/json',
        'MCP-Protocol-Version': '2026-07-28',
        'Mcp-Method': 'tools/call',
        'Mcp-Name': name,
      },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: clientVersion,
        method: 'tools/call',
        params: {
          name,
          arguments: input,
          _meta: {
            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
            'io.modelcontextprotocol/clientInfo': {
              name: 'synthetic-journey',
              version: clientVersion,
            },
            'io.modelcontextprotocol/clientCapabilities': {},
          },
        },
      }),
    });
    const body = (await response.json()) as {
      result?: {
        isError?: boolean;
        structuredContent?: {
          id: string;
          version: number;
          updated?: boolean;
        };
      };
    };
    if (
      !response.ok ||
      body.result?.isError ||
      !body.result?.structuredContent?.id
    )
      throw new Error(`The real ${name} tool must write the journey memory.`);
    return body.result.structuredContent;
  }
  const remembered = await writeMemory(
    'remember',
    {
      bucket: 'work/memory-journey',
      content: '# Owner journey memory\n\nPrefer pnpm for project commands.',
      tags: ['tooling'],
    },
    '1',
  );
  if (remembered.version !== 1)
    throw new Error('The journey must begin with the first version.');
  const updated = await writeMemory(
    'update',
    {
      id: remembered.id,
      expectedVersion: remembered.version,
      content: '# Owner journey memory\n\nRun pnpm verify before shipping.',
    },
    '2',
  );
  if (!updated.updated || updated.version !== 2 || updated.id !== remembered.id)
    throw new Error(
      'The real update tool must append version 2 to the memory.',
    );
  await screen.getByRole('link', { name: 'Memory', exact: true }).click();
  await browser.locator('[data-path="work/memory-journey"] a').click();
  const memoryRow = browser.locator(`[data-memory-row="${remembered.id}"]`);
  await expect(memoryRow).toContainText('Owner journey memory');
  await memoryRow.click();
  const detail = screen.getByRole('article', { name: 'Memory detail' });
  await expect(detail).toContainText('Run pnpm verify before shipping.');
  await expect(detail).toContainText('synthetic-journey 2');
  await expect(detail).toContainText('Owner');
  await detail
    .getByRole('button', { name: 'History 2 versions', exact: true })
    .click();
  const sheet = screen.getByRole('dialog');
  await expect(browser.locator('[data-version-row]')).toHaveCount(2);
  await expect(browser.locator('[data-version-row="2"]')).toContainText(
    'Owner · synthetic-journey 2',
  );
  const firstVersion = browser.locator('[data-version-row="1"]');
  await expect(firstVersion).toContainText('Owner · synthetic-journey 1');
  await firstVersion.click();
  await expect(
    sheet.getByRole('heading', { name: 'Version 1 of 2', exact: true }),
  ).toBeVisible();
  await expect(sheet).toContainText('Prefer pnpm for project commands.');
  const showChanges = sheet.getByRole('button', {
    name: 'Show changes',
    exact: true,
  });
  await expect(showChanges).toBeDisabled();
  await expect(
    sheet.getByText('First version, nothing to compare', { exact: true }),
  ).toBeVisible();
  await sheet
    .getByRole('button', { name: 'Newer version', exact: true })
    .click();
  await expect(
    sheet.getByRole('heading', { name: 'Version 2 of 2', exact: true }),
  ).toBeVisible();
  await expect(showChanges).toBeEnabled();
  await showChanges.click();
  await expect(showChanges).toHaveAttribute('aria-pressed', 'true');
  await expect(
    sheet.getByText('Compared with version 1', { exact: true }),
  ).toBeVisible();
  await expect(
    browser.locator('[data-memory-diff] [data-diff-row="del"]'),
  ).toContainText('Removed: Prefer pnpm for project commands.');
  await expect(
    browser.locator('[data-memory-diff] [data-diff-row="add"]'),
  ).toContainText('Added: Run pnpm verify before shipping.');
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E9: the synthetic owner opens Nook and sees their identity', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await expect(screen.getByRole('heading')).toHaveText("You're signed in");
  await expect(screen.getByText('owner@nook.test').first()).toBeVisible();
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E13: the owner creates work/acme inside work', async ({
  app,
  agent,
  screen,
  browser,
}) => {
  await app.open('/');
  await expect(screen.getByRole('heading')).toHaveText("You're signed in");
  await screen.getByRole('link', { name: 'Buckets', exact: true }).click();
  await expect(
    screen.getByRole('heading', { name: 'Buckets', exact: true }),
  ).toBeVisible();
  await agent.act(
    'Create the bucket work/acme using the New bucket path field.',
  );
  await expect(
    browser
      .locator('li[data-bucket="work"] ul [data-path="work/acme"]')
      .getByText('acme', { exact: true }),
  ).toBeVisible();
  await expect(
    screen.getByRole('button', {
      name: 'Actions for work/acme',
      exact: true,
    }),
  ).toBeVisible();
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E24: the owner stores a secret in Vault and sees only its metadata', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  await screen.getByRole('link', { name: 'Buckets', exact: true }).click();
  await screen
    .getByRole('textbox', { name: 'New bucket path' })
    .fill('work/vault-journey');
  await screen.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(
    screen.getByRole('button', {
      name: 'Actions for work/vault-journey',
      exact: true,
    }),
  ).toBeVisible();
  await screen.getByRole('link', { name: 'Vault', exact: true }).click();
  await browser
    .locator('[data-path="work/vault-journey"]')
    .getByRole('link')
    .click();
  await screen
    .getByRole('button', { name: 'New secret', exact: true })
    .first()
    .click();
  const sheet = screen.getByRole('dialog');
  await sheet
    .getByRole('textbox', { name: 'Name', exact: true })
    .fill('JOURNEY_KEY');
  await sheet
    .getByRole('textbox', { name: 'Description', exact: true })
    .fill('Synthetic owner journey');
  await sheet
    .getByRole('textbox', { name: 'Value', exact: true })
    .fill('synthetic-owner-journey-value');
  await sheet.getByRole('button', { name: 'Save secret', exact: true }).click();
  await expect(screen.getByRole('alert')).toContainText('Stored');
  await expect(
    browser.locator('[data-secret="work/vault-journey/JOURNEY_KEY"]'),
  ).toContainText('Synthetic owner journey');
  const privateValueAbsent = await browser.evaluate(() =>
    JSON.stringify(
      !document.documentElement.innerHTML.includes(
        'synthetic-owner-journey-value',
      ),
    ),
  );
  if (privateValueAbsent !== 'true')
    throw new Error('The settled journey must retain metadata only.');
  if (process.env.COVERAGE_RUN)
    await observe(
      JSON.parse(
        await browser.evaluate(() =>
          JSON.stringify({
            seam: 'browser',
            loaded: globalThis.__authoredModules__ ?? {},
            counters: globalThis.__coverage__ ?? {},
          }),
        ),
      ),
    );
});

test('E27: nook run records exactly one use visible to the owner', async ({
  app,
  screen,
  browser,
}) => {
  await app.open('/');
  const origin = JSON.parse(
    await browser.evaluate(() => JSON.stringify(location.origin)),
  ) as string;
  const keyring = await privateKeyring();
  const path = 'work/run-journey/JOURNEY_KEY';
  const value = `synthetic-run-journey-${randomUUID()}`;
  async function post(route: string, payload: unknown) {
    const response = await fetch(origin + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error('The synthetic journey setup must succeed.');
    return response;
  }
  try {
    await post('/api/buckets', { path: 'work/run-journey' });
    await post('/api/secrets', {
      bucket: 'work/run-journey',
      name: 'JOURNEY_KEY',
      description: 'Audited owner journey',
      value,
      writeId: randomUUID(),
    });
    const pending = (await (
      await post('/api/machine/authorizations', {
        suggestedName: 'journey-machine',
        client: 'synthetic journey',
      })
    ).json()) as { userCode: string; deviceCode: string };
    await post(`/api/authorizations/${pending.userCode}/approve`, {
      machineName: 'journey-machine',
      grant: ['work/run-journey'],
    });
    const approved = (await (
      await post('/api/machine/token', { deviceCode: pending.deviceCode })
    ).json()) as { token: string };
    if ((await keyring.store(origin, approved.token)) !== 0)
      throw new Error(
        'The private journey keyring must store its fixture token.',
      );
    await mkdir(keyring.config.slice(0, keyring.config.lastIndexOf('/')), {
      recursive: true,
    });
    await writeFile(keyring.config, JSON.stringify({ url: origin }));
    const expected = createHash('sha256').update(value).digest('hex');
    const child =
      'const {createHash}=require("node:crypto");process.exit(createHash("sha256").update(process.env.JOURNEY_KEY).digest("hex")===process.argv[1]?0:1)';
    const result = await keyring.start([
      'run',
      '--secret',
      `JOURNEY_KEY=${path}`,
      '--purpose',
      'verify the owner audit journey',
      '--',
      process.execPath,
      '-e',
      child,
      expected,
    ]).done;
    if (result.status !== 0 || result.stdout || result.stderr)
      throw new Error(
        'The journey command must receive its exact value silently.',
      );
    await screen.getByRole('link', { name: 'Audit', exact: true }).click();
    await expect(
      screen.getByRole('heading', { name: 'Audit', exact: true }),
    ).toBeVisible();
    const row = browser.locator('[data-entry]');
    await expect(row).toHaveCount(1);
    await expect(row).toContainText('verify the owner audit journey');
    await expect(row).toContainText('journey-machine');
    await expect(row).toContainText('Delivered');
    if (process.env.COVERAGE_RUN)
      await observe(
        JSON.parse(
          await browser.evaluate(() =>
            JSON.stringify({
              seam: 'browser',
              loaded: globalThis.__authoredModules__ ?? {},
              counters: globalThis.__coverage__ ?? {},
            }),
          ),
        ),
      );
  } finally {
    await keyring.close();
  }
});
