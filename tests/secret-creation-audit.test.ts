import { beforeEach, expect, it } from 'vitest';
import { machineCreate, machineCreateInput } from './support/agent-create.ts';
import { auditPageData } from './support/audit.ts';
import { issueGrant } from './support/grants.ts';
import { listMachines } from './support/machines.ts';
import {
  createSecret,
  deleteSecret,
  secretRows,
  vaultRuntime,
} from './support/vault.ts';

let app: Awaited<ReturnType<typeof vaultRuntime>>;
beforeEach(async () => {
  app = await vaultRuntime();
  return () => app.close();
});

it.each([
  {
    scenario: 'different names in one bucket',
    firstBucket: 'work/acme',
    secondBucket: 'work/acme',
    firstName: 'FIRST_TOKEN',
    secondName: 'SECOND_TOKEN',
    firstGrant: ['work/acme'],
    secondGrant: ['work/acme'],
    anotherMachine: false,
  },
  {
    scenario: 'the same name in different buckets',
    firstBucket: 'work/acme',
    secondBucket: 'work/globex',
    firstName: 'SHARED_TOKEN',
    secondName: 'SHARED_TOKEN',
    firstGrant: ['work'],
    secondGrant: ['work'],
    anotherMachine: false,
  },
  {
    scenario: 'different machines creating in one bucket',
    firstBucket: 'work/acme',
    secondBucket: 'work/acme',
    firstName: 'FIRST_TOKEN',
    secondName: 'SECOND_TOKEN',
    firstGrant: ['work/acme'],
    secondGrant: ['work/acme'],
    anotherMachine: true,
  },
  {
    scenario: 'different machines with separate bucket grants',
    firstBucket: 'work/acme',
    secondBucket: 'work/globex',
    firstName: 'SHARED_TOKEN',
    secondName: 'SHARED_TOKEN',
    firstGrant: ['work/acme'],
    secondGrant: ['work/globex'],
    anotherMachine: true,
  },
])(
  'each actual creation is audited when one writeId is reused for $scenario',
  async ({
    firstBucket,
    secondBucket,
    firstName,
    secondName,
    firstGrant,
    secondGrant,
    anotherMachine,
  }) => {
    const { token: firstToken } = await issueGrant(app, firstGrant);
    const [firstMachine] = await listMachines(app);
    let secondToken = firstToken;
    let secondMachine = firstMachine;
    if (anotherMachine) {
      ({ token: secondToken } = await issueGrant(app, secondGrant));
      const issuedMachine = (await listMachines(app)).find(
        (machine) => machine.id !== firstMachine.id,
      );
      if (!issuedMachine)
        throw new Error('The second machine must have its own approval.');
      secondMachine = issuedMachine;
    }
    const first = machineCreateInput({
      bucket: firstBucket,
      name: firstName,
    });
    const second = machineCreateInput({
      bucket: secondBucket,
      name: secondName,
      writeId: first.writeId,
      purpose: 'second provider setup',
      workingDirectory: `/synthetic/${secondBucket}`,
    });
    expect((await machineCreate(app, firstToken, first)).status).toBe(201);
    expect((await machineCreate(app, secondToken, second)).status).toBe(201);
    const rows = await secretRows(app);
    expect(rows).toHaveLength(2);
    const entries = (await auditPageData(app)).entries;
    expect(entries).toHaveLength(2);
    expect(new Set(entries.map((entry) => entry.id)).size).toBe(2);
    for (const [input, machine] of [
      [first, firstMachine],
      [second, secondMachine],
    ] as const) {
      expect(
        entries.find((entry) => entry.path === `${input.bucket}/${input.name}`),
      ).toMatchObject({
        outcome: 'created',
        purpose: input.purpose,
        machine: { id: machine.id, name: machine.name },
        workingDirectory: input.workingDirectory,
      });
    }
    for (const [token, input] of [
      [firstToken, first],
      [secondToken, second],
    ] as const) {
      expect(
        (
          await machineCreate(app, token, {
            ...input,
            value: 'synthetic-changed-replay',
            purpose: 'repeated request',
          })
        ).status,
      ).toBe(201);
    }
    expect(await secretRows(app)).toEqual(rows);
    expect((await auditPageData(app)).entries).toEqual(entries);
  },
);

it('a replay of an owner-created version adds no machine creation event', async () => {
  const input = machineCreateInput();
  expect((await createSecret(app, input)).status).toBe(201);
  const rows = await secretRows(app);
  const { token } = await issueGrant(app, ['work/acme']);
  expect((await machineCreate(app, token, input)).status).toBe(201);
  expect(await secretRows(app)).toEqual(rows);
  expect((await auditPageData(app)).entries).toEqual([]);
});

it('delete and recreate with the same writeId records a new creation while retries preserve both events', async () => {
  const { token } = await issueGrant(app, ['work/acme']);
  const input = machineCreateInput();
  const path = `${input.bucket}/${input.name}`;
  expect((await machineCreate(app, token, input)).status).toBe(201);
  const [original] = (await auditPageData(app)).entries;
  if (original.outcome !== 'created')
    throw new Error('The initial machine creation must be audited as created.');
  expect((await deleteSecret(app, path, input.writeId)).status).toBe(204);
  expect((await auditPageData(app)).entries).toEqual([original]);
  const recreated = {
    ...input,
    purpose: 'recreate the deleted provider token',
  };
  expect((await machineCreate(app, token, recreated)).status).toBe(201);
  const entries = (await auditPageData(app)).entries;
  expect(entries).toHaveLength(2);
  expect(entries.find((entry) => entry.id === original.id)).toEqual(original);
  expect(entries.find((entry) => entry.id !== original.id)).toMatchObject({
    path,
    outcome: 'created',
    purpose: recreated.purpose,
    machine: original.machine,
  });
  const rows = await secretRows(app);
  expect(rows).toHaveLength(1);
  expect((await machineCreate(app, token, recreated)).status).toBe(201);
  expect(await secretRows(app)).toEqual(rows);
  expect((await auditPageData(app)).entries).toEqual(entries);
});

it('a matching existing writeId never lets a limited machine replay outside its grant', async () => {
  const input = machineCreateInput();
  const { token } = await issueGrant(app, ['work/acme']);
  for (const bucket of ['me', 'work', 'personal/finances'])
    expect((await createSecret(app, { ...input, bucket })).status).toBe(201);
  const rows = await secretRows(app);
  for (const bucket of ['me', 'work', 'personal/finances'])
    expect((await machineCreate(app, token, { ...input, bucket })).status).toBe(
      403,
    );
  expect(await secretRows(app)).toEqual(rows);
  expect((await auditPageData(app)).entries).toEqual([]);
});
