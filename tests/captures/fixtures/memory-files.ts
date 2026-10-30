import { memoryFixture, seedMemories } from '../../support/memory.ts';
import {
  fileBucket,
  pdfName,
  type seedFile,
} from '../../support/memory-files.ts';
import type { FilesRuntime } from '../../support/memory-files-runtime.ts';

export const fileCaptureStates = [
  'one-pdf',
  'many-files',
  'long-name',
  'download-pending',
  'download-missing',
  'download-unavailable',
] as const;
export type FileCaptureState = (typeof fileCaptureStates)[number];

type Seed = NonNullable<Parameters<typeof seedFile>[1]>;
function file(
  name: string,
  mediaType: string,
  size: number,
  attachedAt: string,
  by = 'LG16',
): Seed {
  return {
    name,
    mediaType,
    bytes: Buffer.alloc(size, 30),
    attachedAt,
    principal:
      by === 'Owner'
        ? { kind: 'owner' }
        : { kind: 'machine', id: `synthetic-${by}`, name: by },
    client: { name: 'nook-acceptance', version: '1.0' },
  };
}
export function capturedFiles(state: FileCaptureState): Seed[] {
  if (state === 'long-name')
    return [
      file(
        'Guía de integración R4 Conecta – Banco Mi Banco – Pago Móvil, Débito Inmediato, C2P y Consulta de Operaciones – versión 3.0 mayo 2025 – código D-PYM-001 – CONFIDENCIAL – no distribuir fuera del equipo de pagos de Mamasan – copia re.pdf',
        'application/pdf',
        9_437_184,
        '2026-10-22T14:23:00.000Z',
      ),
    ];
  const pdf = file(
    pdfName,
    'application/pdf',
    2_418_734,
    '2026-10-22T14:23:00.000Z',
  );
  if (state !== 'many-files') return [pdf];
  return [
    pdf,
    file('r4-page-map.png', 'image/png', 583_449, '2026-10-22T14:25:00.000Z'),
    file(
      'pago-movil-codes.csv',
      'text/csv',
      18_776,
      '2026-10-22T14:31:00.000Z',
      'Owner',
    ),
    file(
      'sandbox-requests.zip',
      'application/zip',
      24_802_113,
      '2026-10-21T18:02:00.000Z',
      'desk-linux',
    ),
    file(
      'firma-hmac-ejemplos.txt',
      'text/plain',
      4_096,
      '2026-10-21T17:48:00.000Z',
      'desk-linux',
    ),
    file(
      'diagrama de flujo débito inmediato.png',
      'image/png',
      335_881,
      '2026-10-20T11:09:00.000Z',
    ),
    file(
      'r4-openapi-v3.0.json',
      'application/json',
      142_330,
      '2026-10-20T10:41:00.000Z',
    ),
    file(
      'Anexo B – Códigos de error.xlsx',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      96_412,
      '2026-10-19T16:15:00.000Z',
      'Owner',
    ),
    file(
      'certificado-sandbox.pem',
      'application/x-pem-file',
      2_117,
      '2026-10-19T09:30:00.000Z',
      'desk-linux',
    ),
    file(
      'webhook-payload-ejemplo.json',
      'application/json',
      3_804,
      '2026-10-18T20:12:00.000Z',
    ),
    file(
      'conciliacion-octubre.csv',
      'text/csv',
      1_204_877,
      '2026-10-17T13:55:00.000Z',
      'desk-linux',
    ),
    file(
      'postman-collection-r4',
      'application/octet-stream',
      512,
      '2026-10-16T08:20:00.000Z',
    ),
  ];
}

export const capturedMemory = memoryFixture(601, {
  bucket: fileBucket,
  content: `# R4 Conecta integration guide v3.0: where it is and what matters

This synthetic memory records an integration guide shared with the team. Files attached to the memory travel with it between machines.

## What matters

- Check the integration guide before changing the payment flow.
- Keep sample payloads and diagrams beside the written context.
- Review the sandbox checklist before promoting a change.

## Working context

The attached documents are synthetic verification data. Agents use the CLI to attach and download files; memory history keeps the written versions.`,
  tags: ['r4-conecta', 'banking'],
  createdAt: '2026-10-22T17:05:00.000Z',
  principal: { kind: 'owner' },
  client: { name: 'nook-acceptance', version: '1.0' },
  workingDirectory: null,
});

export async function captureNeighbors(app: FilesRuntime) {
  await seedMemories(app, [
    memoryFixture(602, {
      bucket: fileBucket,
      content:
        '# Mamasan checkout flow decisions\n\nKeep the checkout state in the payment service.',
      principal: { kind: 'owner' },
      createdAt: '2026-10-22T17:06:00.000Z',
    }),
    memoryFixture(603, {
      bucket: 'work',
      content:
        '# Banking integrations: shared rules for sandbox tests\n\nUse synthetic payloads for verification.',
      principal: { kind: 'owner' },
      createdAt: '2026-10-22T17:07:00.000Z',
    }),
  ]);
}
