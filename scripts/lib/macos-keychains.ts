import { execFile } from 'node:child_process';

export type KeychainObservation = {
  searchList: string;
  defaultKeychain: string;
  loginKeychain: string;
};

function observe(home: string, args: string[]) {
  return new Promise<string>((accept, reject) => {
    execFile(
      '/usr/bin/security',
      args,
      {
        env: { HOME: home, PATH: '/usr/bin:/bin', LANG: 'C' },
        timeout: 5000,
        encoding: 'utf8',
      },
      (error, stdout) => {
        if (!error) accept(stdout.trim());
        else if (error.code === 1) accept('<absent>');
        else
          reject(
            new Error(
              'Host isolation could not observe the owner keychain paths.',
            ),
          );
      },
    );
  });
}

// Only these three read-only commands may run with the real owner's HOME.
export async function observeKeychains(
  home: string,
): Promise<KeychainObservation> {
  const [searchList, defaultKeychain, loginKeychain] = await Promise.all([
    observe(home, ['list-keychains', '-d', 'user']),
    observe(home, ['default-keychain', '-d', 'user']),
    observe(home, ['login-keychain']),
  ]);
  return { searchList, defaultKeychain, loginKeychain };
}
