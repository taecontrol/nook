import { fileLimits } from '@nook/contract';
import type { FileActor } from './audit.ts';
import { clientFrom } from './client-provenance.ts';

export function fileActor(request: Request): FileActor {
  const source = request as Request & { cf?: { country?: string } };
  return {
    principal: { kind: 'owner' },
    client: clientFrom(undefined, request.headers.get('User-Agent')),
    ip: request.headers.get('CF-Connecting-IP') || null,
    country: source.cf?.country || null,
  };
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
  if (Number(length) > fileLimits.bytes)
    return Response.json(
      { _tag: 'FileTooLarge', message: 'A file can be at most 25 MiB.' },
      { status: 413 },
    );
}
function unicodeGate(path: string) {
  // URL decoding can otherwise fail before domain validation (invalid UTF-8).
  try {
    decodeURIComponent(path.split('/').at(-1) ?? '');
  } catch {
    return Response.json(
      { _tag: 'InvalidFile', message: 'Use valid Unicode for the file name.' },
      { status: 400 },
    );
  }
}

export function fileRequestGate(request: Request, path: string) {
  if (!/^\/api\/(?:machine\/)?memories\/[^/]+\/files\/[^/]+$/.test(path))
    return;
  if (request.method === 'HEAD')
    return new Response(null, {
      status: 405,
      headers: { Allow: path.startsWith('/api/machine/') ? 'GET, PUT' : 'GET' },
    });
  return (
    (request.method === 'PUT' ? lengthGate(request) : undefined) ??
    unicodeGate(path)
  );
}
