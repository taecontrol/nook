import { mkdir, mkdtemp } from 'node:fs/promises';
import { userInfo } from 'node:os';
import { isAbsolute, resolve, sep } from 'node:path';

const inheritedNames = [
  'PATH',
  'LANG',
  'TZ',
  'NOOK_TEST_RUN',
  'COVERAGE_RUN',
  'NOOK_BUILD',
  'PLAYWRIGHT_BROWSERS_PATH',
  'CI',
  'FORCE_COLOR',
  'NOOK_TEST_MACOS_KEYCHAIN_BOOTSTRAP',
  'NOOK_TEST_PROCESS_GROUPS',
  'NOOK_TEST_ROOT_PID',
];
const overrideNames = new Set([
  ...inheritedNames,
  'NODE_OPTIONS',
  'COVERAGE_RUN',
  'NOOK_BUILD',
  'NOOK_CLI_COVERAGE',
  'NOOK_TEST_SERVICE',
  'NOOK_TEST_OPEN_STATUS',
  'FORCE_COLOR',
  'CI',
  'PLAYWRIGHT_BROWSERS_PATH',
  'WRANGLER_SEND_METRICS',
  'E2E_TELEMETRY_DISABLED',
  'GITHUB_REPOSITORY',
  'GITHUB_OUTPUT',
  'DEPLOY_SHA',
  'MAIN_HEAD',
  'LATEST_ARGS',
  'PREFLIGHT_ARGS',
  'PREFLIGHT_COUNT',
  'GIT_CONFIG_NOSYSTEM',
  'VERSION',
  'RELEASE_TAG_DEPLOY_KEY',
  'RELEASE_LOG',
  'RELEASE_REMOTES',
]);
const directories = {
  XDG_CONFIG_HOME: 'config',
  XDG_DATA_HOME: 'data',
  XDG_STATE_HOME: 'state',
  XDG_CACHE_HOME: 'cache',
  XDG_RUNTIME_DIR: 'runtime',
  TMPDIR: 'runtime',
};

function safeDirectory(home: string, name: string, value: string | undefined) {
  // The CLI deliberately exercises its documented config fallback.
  if (name === 'XDG_CONFIG_HOME' && (!value || !isAbsolute(value))) return;
  if (!value || !resolve(value).startsWith(`${resolve(home)}${sep}`))
    throw new Error('Test directories must stay inside temporary HOME.');
}

function inheritedEnvironment() {
  const env: NodeJS.ProcessEnv = {};
  for (const name of inheritedNames) {
    if (process.env[name] !== undefined) env[name] = process.env[name];
  }
  for (const [name, value] of Object.entries(process.env)) {
    if (/^LC_[A-Z_]+$/.test(name)) env[name] = value;
  }
  return env;
}

function applyOverrides(
  env: NodeJS.ProcessEnv,
  home: string,
  overrides: NodeJS.ProcessEnv,
) {
  for (const [name, value] of Object.entries(overrides)) {
    if (Object.hasOwn(directories, name) || name === 'NOOK_TEST_PROCESS_GROUPS')
      safeDirectory(home, name, value);
    else if (!overrideNames.has(name) && !/^LC_[A-Z_]+$/.test(name))
      throw new Error('Test environment override is not allowlisted.');
    if (value === undefined) delete env[name];
    else env[name] = value;
  }
}

export function testEnvironment(
  home: string | undefined,
  overrides: NodeJS.ProcessEnv = {},
  privateBus?: string,
) {
  if (!home || !isAbsolute(home))
    throw new Error('A temporary absolute HOME is required.');
  if (resolve(home) === resolve(userInfo().homedir))
    throw new Error('The owner HOME cannot be used as a temporary HOME.');
  const env = inheritedEnvironment();
  env.HOME = resolve(home);
  for (const [name, directory] of Object.entries(directories))
    env[name] = resolve(home, directory);
  applyOverrides(env, home, overrides);
  // An unset address can discover or activate the OS user's session bus.
  env.DBUS_SESSION_BUS_ADDRESS = unavailableSessionBus(home);
  if (privateBus !== undefined) {
    const path = /^unix:path=([^,]+),guid=[0-9a-f]+$/.exec(privateBus)?.[1];
    if (!path || decodeURIComponent(path) !== resolve(home, 'bus'))
      throw new Error('A private session bus is required.');
    env.DBUS_SESSION_BUS_ADDRESS = privateBus;
  }
  return env;
}

export function unavailableSessionBus(home: string) {
  return `unix:path=${encodeURIComponent(resolve(home, 'unavailable-session-bus'))}`;
}

export async function temporaryTestHome(prefix = '/tmp/nook-test-run-') {
  const home = await mkdtemp(prefix);
  for (const directory of new Set(Object.values(directories)))
    await mkdir(resolve(home, directory), { mode: 0o700 });
  return home;
}
