import { createHash } from 'node:crypto';
import {
  manyMemories,
  memoryFixture,
  tenTags,
  typicalMemories,
} from './memories.ts';

export const spanishRelease =
  '# Proceso de release\n\nPara publicar una versión nueva: fusionamos la rama en main, esperamos a que la integración continua quede en verde y luego lanzamos el flujo de publicación a mano desde GitHub Actions. El flujo compila el binario, lo firma y sube los artefactos. Nunca creamos etiquetas a mano. Si algo falla en producción, revertimos al artefacto anterior con wrangler rollback.';
export const identicalContent =
  '# Shared deployment\n\nUse pnpm verify before deployment.';
export const searchMemories = [
  memoryFixture(20, {
    bucket: 'work',
    content: spanishRelease,
    tags: ['deploy', 'cli'],
  }),
  memoryFixture(21, {
    content:
      '# Deploying the marketing site\n\nThe marketing site is a static build hosted on Cloudflare Pages. Every push to the website repository main branch triggers a Pages build automatically; no manual step is needed.',
  }),
  memoryFixture(22, {
    bucket: 'work',
    content:
      '# Despliegue de la documentación\n\nLa documentación se genera con un generador estático y se publica en Pages al hacer push. No forma parte del flujo de publicación de la CLI.',
  }),
  memoryFixture(23, {
    content: '# Required verification\n\npnpm verify',
    tags: ['deploy', 'cli'],
  }),
  memoryFixture(24, { content: '# Despliégue\n\nDESPLIEGUE de la canción.' }),
  memoryFixture(25, {
    content: '# Deployment checklist\n\nConfirm the exact commit.',
  }),
  memoryFixture(26, {
    bucket: 'me',
    content: '# Preferred commands\n\nUse pnpm for installs and scripts.',
  }),
];
export const deepBucket = Array.from(
  { length: 6 },
  (_, i) => `${String.fromCharCode(97 + i).repeat(32)}`,
).join('/');
export const largeContent =
  `# Full memory\n\n${'Revisar la publicación y comprobar el proceso de compilación. '.repeat(300)}`.slice(
    0,
    12000,
  );
export const denseContent = Array.from({ length: 1024 }, (_, i) =>
  createHash('sha256').update(`dense-${i}`).digest('hex'),
)
  .join(' ')
  .slice(0, 16384);
export const extremeMemories = Array.from({ length: 20 }, (_, i) =>
  memoryFixture(300 + i, {
    bucket:
      i % 7 === 6
        ? 'me'
        : deepBucket
            .split('/')
            .slice(0, (i % 7) + 1)
            .join('/'),
    content: `# Conciliación de pagos nocturna ${i}: comprobar los registros del proceso y las alertas antes de iniciar una nueva publicación de la aplicación\n\nLa conciliación de pagos exige revisar la ejecución anterior y los errores del proceso. Si hay un fallo, conservar el informe y avisar a la persona de guardia.`,
    tags: i % 4 === 0 ? tenTags : ['deploy'],
  }),
);
export const hostileQueries = [
  '"',
  '-',
  ':',
  '(',
  '*',
  '^',
  'NEAR',
  'AND',
  'a\0b',
  '\0',
  'deploy\u0001verify',
  'ＡＮＤ',
  'foo"bar',
  'a OR b',
  'despliégue',
];
export const recordedTexts = [
  ...new Set([
    ...searchMemories.map((m) => m.content),
    ...typicalMemories.map((m) => m.content),
    ...manyMemories.map((m) => m.content),
    ...extremeMemories.map((m) => m.content),
    spanishRelease,
    identicalContent,
    largeContent,
    denseContent,
    'how do we deploy',
    'pnpm verify',
    'despliegue',
    'deploy',
    'shared deployment',
    'publicar',
    'kubernetes helm chart',
    'deployment',
    'conciliación de pagos',
    '# Fresh publication\n\nPara publicar una versión nueva, lanzar el flujo de publicación cuando la integración continua esté en verde.',
    '# Owner journey memory\n\nPrefer pnpm for project commands.',
    ...hostileQueries,
  ]),
];
