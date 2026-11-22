import {
  type BucketGrant,
  RequireWholeInstallation,
  WholeInstallationGrant,
} from '@nook/contract';
import { Effect, Layer } from 'effect';
import { HttpApiError } from 'effect/http-api';

export type OwnerFacts = { ip: string | null; country: string | null };
export function ownerFacts(request: Request): OwnerFacts {
  return {
    ip: request.headers.get('CF-Connecting-IP') || null,
    country:
      (request as Request & { cf?: { country?: string } }).cf?.country || null,
  };
}

export function wholeInstallationGuard(grant: BucketGrant) {
  return Layer.succeed(RequireWholeInstallation, (httpEffect) =>
    grant === 'all'
      ? Effect.provideService(httpEffect, WholeInstallationGrant, {
          grant: 'all',
        })
      : Effect.fail(new HttpApiError.Forbidden()),
  );
}
