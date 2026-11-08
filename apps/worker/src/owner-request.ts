import type { BucketGrant } from '@nook/contract';
import { Effect } from 'effect';
import { HttpApiError } from 'effect/http-api';

export type OwnerFacts = { ip: string | null; country: string | null };
export function ownerFacts(request: Request): OwnerFacts {
  return {
    ip: request.headers.get('CF-Connecting-IP') || null,
    country:
      (request as Request & { cf?: { country?: string } }).cf?.country || null,
  };
}

export const requireOwner = (
  grant: BucketGrant,
): Effect.Effect<void, HttpApiError.Forbidden> =>
  grant === 'all' ? Effect.void : Effect.fail(new HttpApiError.Forbidden());
