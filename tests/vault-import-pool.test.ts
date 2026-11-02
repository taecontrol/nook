import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { RequestFailure, ServerFailure } from '../apps/cli/src/errors.ts';
import { type ImportedKey, writeKeys } from '../apps/cli/src/vault-import.ts';
import { parseEnv } from '../packages/contract/src/index.ts';
import { deferred } from './support/machines.ts';

type Request = Parameters<typeof writeKeys>[0];

// The pool runs in-process here. KEY_0 is refused once three creates are in
// flight, and KEY_1 and KEY_2 are answered only after that refusal has been
// recorded, so a correct pool can never start another create.
async function importWithFirstRefusal(tag: string) {
  const { entries } = parseEnv(
    Array.from({ length: 7 }, (_, i) => `KEY_${i}=value-${i}`).join('\n'),
  );
  const keys: ImportedKey[] = entries.map(({ line, name }) => ({
    line,
    name,
    result: { status: 'not tried' },
  }));
  const sent: string[] = [];
  const refuse = deferred();
  const release = deferred();
  const refusal = new RequestFailure(
    'Refused.',
    new ServerFailure(tag),
    'Refused.',
  );
  const api = {
    machine: {
      createSecret: ({ payload }: { payload: { name: string } }) => {
        sent.push(payload.name);
        if (sent.length === 3) refuse.resolve();
        return payload.name === 'KEY_0'
          ? Effect.promise(() => refuse.promise).pipe(
              Effect.andThen(Effect.fail(refusal)),
            )
          : Effect.promise(() => release.promise);
      },
    },
  };
  const request = ((operation: (api: unknown, headers: unknown) => unknown) =>
    operation(api, { authorization: '' })) as unknown as Request;
  const run = Effect.runPromise(
    writeKeys(request, entries, keys, {
      bucket: 'work/acme',
      purpose: 'test',
      workingDirectory: '/',
    }),
  );
  await expect.poll(() => keys[0].result.status).toBe('failed');
  release.resolve();
  await run;
  return { sent, statuses: keys.map((key) => key.result.status) };
}

it.each(['Forbidden', 'BucketNotFound', 'VaultNotConfigured', 'Unauthorized'])(
  'E10: after a first-answer %s no new create starts; in-flight creates settle and the rest are not tried',
  async (tag) => {
    const { sent, statuses } = await importWithFirstRefusal(tag);
    expect(sent).toEqual(['KEY_0', 'KEY_1', 'KEY_2']);
    expect(statuses).toEqual([
      'failed',
      'created',
      'created',
      'not tried',
      'not tried',
      'not tried',
      'not tried',
    ]);
  },
);

it('E10: a per-key refusal does not stop the remaining creates', async () => {
  const { sent, statuses } = await importWithFirstRefusal('InvalidSecret');
  expect(sent).toHaveLength(7);
  expect(statuses).toEqual(['failed', ...Array(6).fill('created')]);
});
