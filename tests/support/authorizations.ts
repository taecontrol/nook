import { expect } from 'vitest';
import type { TestRuntime } from './runtime.ts';

export type Authorization = {
  deviceCode: string;
  userCode: string;
  verificationUrl: string;
  expiresIn: number;
  interval: number;
};
export function jsonRequest(
  app: TestRuntime,
  path: string,
  payload?: unknown,
  headers: Record<string, string> = {},
  method = 'POST',
) {
  return fetch(`${app.origin}${path}`, {
    method,
    // A control request must not inherit a socket from a closed fixture runtime.
    headers: {
      'Content-Type': 'application/json',
      ...headers,
      Connection: 'close',
    },
    ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
  });
}
export async function createAuthorization(
  app: TestRuntime,
  name = 'synthetic-machine',
) {
  const response = await jsonRequest(app, '/api/machine/authorizations', {
    suggestedName: name,
    client: 'nook 0.1.0 · linux-x64',
  });
  expect(response.status, 'Machine authorization creation must be public').toBe(
    200,
  );
  return (await response.json()) as Authorization;
}
export async function approve(
  app: TestRuntime,
  code: string,
  machineName = 'synthetic-machine',
  headers?: Record<string, string>,
) {
  return jsonRequest(
    app,
    `/api/authorizations/${code}/approve`,
    { machineName, grant: 'all' },
    headers,
  );
}
export async function issueToken(app: TestRuntime, name = 'synthetic-machine') {
  const request = await createAuthorization(app, name);
  expect((await approve(app, request.userCode, name)).status).toBe(204);
  const response = await jsonRequest(app, '/api/machine/token', {
    deviceCode: request.deviceCode,
  });
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    token: string;
    machine: string;
    grant: 'all';
  };
  return { ...body, ...request };
}
export async function ownerRuntime(app: TestRuntime) {
  await app.setBindings({
    LOCAL_OWNER: 'synthetic-owner',
    LOCAL_ORIGIN: app.origin,
  });
  return app;
}
