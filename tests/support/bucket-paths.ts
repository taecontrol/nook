export const validPaths = [
  'me',
  'work',
  'work/acme',
  'ac-me',
  'a1/2026',
  'a/b/c/d/e/f',
  'x'.repeat(32),
];
export const invalidPaths = [
  ['', 'Enter a bucket path.'],
  ['Work/Acme', 'Use lowercase letters: work/acme'],
  ...[
    'work/ac_me',
    'work/-x',
    'work/x-',
    'a--b',
    'work/acmé',
    'work/ac me',
  ].map((path) => [
    path,
    'Use lowercase letters, digits, and single hyphens in each segment.',
  ]),
  ...['/work', 'work/', 'work//x'].map((path) => [
    path,
    'Separate segments with a single /, with none at the start or end.',
  ]),
  ['x'.repeat(33), 'Each segment can have at most 32 characters.'],
  ['a/b/c/d/e/f/g', 'A bucket path can have at most 6 levels.'],
];
