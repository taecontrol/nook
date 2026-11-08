import {
  fileNameUnicodeMessage,
  validateFileName,
  validateFileSize,
} from '@nook/contract';
import { type FileActor, ownerFileActor } from './audit.ts';
import { clientFrom } from './client-provenance.ts';
import { ownerFacts } from './owner-request.ts';
import { fileRoutes, matches } from './routes.ts';

export function fileActor(request: Request): FileActor {
  return ownerFileActor(
    clientFrom(undefined, request.headers.get('User-Agent')),
    ownerFacts(request),
  );
}
function lengthGate(request: Request) {
  const length = request.headers.get('Content-Length');
  if (length === null)
    return Response.json({ _tag: 'LengthRequired' }, { status: 411 });
  if (!/^\d+$/.test(length))
    return Response.json(
      { _tag: 'InvalidFile', message: 'Use a valid Content-Length.' },
      { status: 400 },
    );
  const message = validateFileSize(Number(length));
  if (message)
    return Response.json({ _tag: 'FileTooLarge', message }, { status: 413 });
}
function nameGate(path: string) {
  // URL decoding can otherwise fail before domain validation (invalid UTF-8).
  try {
    const name = decodeURIComponent(path.split('/').at(-1) ?? '');
    const message = validateFileName(name);
    if (message)
      return Response.json({ _tag: 'InvalidFile', message }, { status: 400 });
  } catch {
    return Response.json(
      { _tag: 'InvalidFile', message: fileNameUnicodeMessage },
      { status: 400 },
    );
  }
}

export function fileRequestGate(request: Request, path: string) {
  if (!matches(fileRoutes, request.method, path)) return;
  if (request.method === 'HEAD')
    return new Response(null, {
      status: 405,
      headers: { Allow: matches(fileRoutes, 'PUT', path) ? 'GET, PUT' : 'GET' },
    });
  return (
    (request.method === 'PUT' ? lengthGate(request) : undefined) ??
    nameGate(path)
  );
}
