import { readFile } from 'node:fs/promises';
import { expect } from 'vitest';

export function waitingOutput(url: string, code: string) {
  return `Open ${url}/cli/authorize and enter this code:\n\n    ${code}\n\nWaiting for approval (expires in 10 minutes)...`;
}

// Assertions must also keep credentials private when a regression makes them fail.
export function expectOutput(actual: string, expected: string, exact = false) {
  expect(
    exact ? actual.trim() === expected : actual.includes(expected),
    'The CLI emits the specified public message',
  ).toBe(true);
}
export async function configHasOnlyUrl(path: string, url: string) {
  try {
    const config = JSON.parse(await readFile(path, 'utf8'));
    return (
      config !== null &&
      typeof config === 'object' &&
      Object.keys(config).length === 1 &&
      config.url === url
    );
  } catch {
    return false;
  }
}
export async function responseHasTag(
  response: Response | undefined,
  tag: string,
  exact = true,
) {
  if (!response) return false;
  try {
    const body = await response.json();
    return (
      body !== null &&
      typeof body === 'object' &&
      body._tag === tag &&
      (!exact || Object.keys(body).length === 1)
    );
  } catch {
    return false;
  }
}
