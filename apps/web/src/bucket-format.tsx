import { RESERVED_BUCKET } from '@nook/contract';
import type { ReactNode } from 'react';

/** The agents that find what is stored in `bucket`. */
export function agentsIn(
  bucket: string,
  hasChildren: boolean,
  name: ReactNode = bucket,
) {
  if (bucket === RESERVED_BUCKET) return 'Agents working in any bucket';
  return (
    <>
      Agents working in {name}
      {hasChildren ? ' or a bucket inside it' : ''}
    </>
  );
}
export function reachText(bucket: string, hasChildren: boolean, what = 'it') {
  return (
    <>
      {agentsIn(bucket, hasChildren)} find {what}.
    </>
  );
}
