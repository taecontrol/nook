import { createHash, randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { privateKeyring } from './cli.ts';

export async function approvalJourney(origin: string) {
  const keyring = await privateKeyring();
  const path = 'work/approval-journey/JOURNEY_KEY';
  async function post(route: string, payload: unknown) {
    const response = await fetch(origin + route, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Connection: 'close' },
      body: JSON.stringify(payload),
    });
    if (!response.ok)
      throw new Error('The synthetic approval journey setup must succeed.');
    return response;
  }
  try {
    await post('/api/buckets', { path: 'work/approval-journey' });
    const value = `synthetic-approval-journey-${randomUUID()}`;
    await post('/api/secrets', {
      bucket: 'work/approval-journey',
      name: 'JOURNEY_KEY',
      description: 'Owner approval journey',
      value,
      writeId: randomUUID(),
    });
    const authorization = (await (
      await post('/api/machine/authorizations', {
        suggestedName: 'approval-journey-machine',
        client: 'synthetic journey',
      })
    ).json()) as { userCode: string; deviceCode: string };
    await post(`/api/authorizations/${authorization.userCode}/approve`, {
      machineName: 'approval-journey-machine',
      grant: ['work/approval-journey'],
    });
    const credential = (await (
      await post('/api/machine/token', { deviceCode: authorization.deviceCode })
    ).json()) as { token: string };
    if ((await keyring.store(origin, credential.token)) !== 0)
      throw new Error(
        'The private approval journey keyring must store its token.',
      );
    await mkdir(keyring.config.slice(0, keyring.config.lastIndexOf('/')), {
      recursive: true,
    });
    await writeFile(keyring.config, JSON.stringify({ url: origin }));
    const digest = createHash('sha256').update(value).digest('hex');
    const script =
      'const {createHash}=require("node:crypto");if(createHash("sha256").update(process.env.JOURNEY_KEY).digest("hex")!==process.argv[1])process.exit(1);process.stdout.write("delivered")';
    const args = [
      'run',
      '--secret',
      `JOURNEY_KEY=${path}`,
      '--purpose',
      'owner approval journey',
      '--',
      process.execPath,
      '-e',
      script,
      digest,
    ];
    return { keyring, args, path };
  } catch (error) {
    await keyring.close();
    throw error;
  }
}
