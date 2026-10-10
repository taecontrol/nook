import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { test } from '@e2e-dev/web';
import { expect } from 'e2e';
import { observe } from '../../scripts/observation.ts';
import { privateKeyring } from '../support/cli.ts';

test('Memory: the owner reads a memory written through MCP with provenance', async ({
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
          bucket: 'work/memory-journey',
          content:
            '# Owner journey memory\n\nPrefer pnpm for project commands.',
          tags: ['tooling'],
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
    throw new Error('The real remember tool must store the journey memory.');
  await screen.getByRole('link', { name: 'Memory', exact: true }).click();
  await browser.locator('[data-path="work/memory-journey"] a').click();
  await expect(browser.locator('[data-memory-row]')).toContainText(
    'Owner journey memory',
  );
  await browser.locator('[data-memory-row]').click();
  const detail = screen.getByRole('article', { name: 'Memory detail' });
  await expect(detail).toContainText('Prefer pnpm for project commands.');
  await expect(detail).toContainText('synthetic-journey 1');
  await expect(detail).toContainText('Owner');
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
