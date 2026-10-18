import { Schema } from 'effect';
import { OpenApi } from 'effect/http-api';
import { expect, it } from 'vitest';
import {
  Api,
  ForgetMemory,
  UpdateMemory,
} from '../packages/contract/src/index.ts';

it.each([UpdateMemory, ForgetMemory])(
  'memory writes accept only positive finite integer versions',
  (schema) => {
    const decode = Schema.decodeUnknownSync(schema);
    const input = { id: 'synthetic-id', content: 'Synthetic content.' };
    expect(decode({ ...input, expectedVersion: 1 }).expectedVersion).toBe(1);
    for (const expectedVersion of [
      0,
      -1,
      1.5,
      Infinity,
      -Infinity,
      NaN,
      Number.MAX_SAFE_INTEGER + 1,
      '1',
      undefined,
    ])
      expect(() => decode({ ...input, expectedVersion })).toThrow();
  },
);

it.each(['/api/memories', '/api/memories/search'])(
  'HTTP %s declares only reachable memory errors',
  (path) => {
    const errors = JSON.stringify(
      OpenApi.fromApi(Api).paths[path]?.get?.responses,
    );
    expect(errors).toContain('BucketNotFound');
    expect(errors).not.toContain(
      '"#/components/schemas/nook_InvalidMemoryEncoded"',
    );
  },
);
