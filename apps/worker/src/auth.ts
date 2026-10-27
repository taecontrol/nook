import type { BucketGrant } from '@nook/contract';
import {
  createRemoteJWKSet,
  customFetch,
  errors,
  type JWTVerifyGetKey,
  jwtVerify,
} from 'jose';

export type AuthBindings = {
  ACCESS_ISSUER?: string;
  ACCESS_AUDIENCE?: string;
  OWNER_EMAIL?: string;
  LOCAL_OWNER?: string;
  LOCAL_ORIGIN?: string;
};

type Rejection =
  | { reason: 'missing-config'; settings: string[] }
  | { reason: 'missing-claim'; claim: 'email' | 'sub' | 'exp' }
  | {
      reason:
        | 'issuer-not-https'
        | 'no-assertion'
        | 'malformed-assertion'
        | 'algorithm-not-allowed'
        | 'unknown-key'
        | 'invalid-signature'
        | 'expired'
        | 'not-yet-valid'
        | 'issuer-mismatch'
        | 'audience-mismatch'
        | 'certs-unavailable'
        | 'not-owner'
        | 'verification-failed';
    };

type Identity =
  | { email: string; grant: BucketGrant }
  | ({ status: 401 | 403 } & Rejection);

const verificationFailed: Rejection = { reason: 'verification-failed' };
const verifierRejections: Readonly<Record<string, Rejection>> = {
  ERR_JWS_INVALID: { reason: 'malformed-assertion' },
  ERR_JWT_INVALID: { reason: 'malformed-assertion' },
  ERR_JOSE_ALG_NOT_ALLOWED: { reason: 'algorithm-not-allowed' },
  ERR_JWKS_NO_MATCHING_KEY: { reason: 'unknown-key' },
  ERR_JWS_SIGNATURE_VERIFICATION_FAILED: { reason: 'invalid-signature' },
  ERR_JWT_EXPIRED: { reason: 'expired' },
  ERR_ACCESS_CERTS_UNAVAILABLE: { reason: 'certs-unavailable' },
  ERR_JOSE_GENERIC: { reason: 'certs-unavailable' },
  ERR_JWKS_TIMEOUT: { reason: 'certs-unavailable' },
};
const claimRejections: Readonly<Record<string, Rejection>> = {
  'missing:email': { reason: 'missing-claim', claim: 'email' },
  'missing:sub': { reason: 'missing-claim', claim: 'sub' },
  'missing:exp': { reason: 'missing-claim', claim: 'exp' },
  'check_failed:iss': { reason: 'issuer-mismatch' },
  'check_failed:aud': { reason: 'audience-mismatch' },
  'check_failed:nbf': { reason: 'not-yet-valid' },
};

function verifierRejection(error: unknown): Rejection {
  if (!(error instanceof errors.JOSEError)) return verificationFailed;
  if (error.code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
    const { reason, claim } = error as errors.JWTClaimValidationFailed;
    return claimRejections[`${reason}:${claim}`] ?? verificationFailed;
  }
  return verifierRejections[error.code] ?? verificationFailed;
}

class CertsUnavailable extends errors.JOSEError {
  override code = 'ERR_ACCESS_CERTS_UNAVAILABLE';
}

function syntheticOwner(request: Request, env: AuthBindings) {
  const url = new URL(request.url);
  const origin = request.headers.get('Origin');
  return (
    env.LOCAL_OWNER === 'synthetic-owner' &&
    url.hostname === '127.0.0.1' &&
    url.origin === env.LOCAL_ORIGIN &&
    (origin === null || origin === url.origin)
  );
}

// jose deliberately does not share its pending fetch in Workers. Coalesce the
// HTTP read into immutable data, then give each request its own Response. Warm
// requests use jose's cache; expiry and unknown-key refresh still work.
function certsFetcher() {
  let pending: Promise<{ status: number; body: string }> | undefined;
  return async (url: string, init: RequestInit) => {
    pending ??= fetch(url, init)
      .then(async (response) => ({
        status: response.status,
        body: await response.text(),
      }))
      .catch(() => {
        // Drop network errors at this boundary; they can contain the issuer.
        throw new CertsUnavailable();
      })
      .finally(() => {
        pending = undefined;
      });
    const result = await pending;
    return new Response(result.body, { status: result.status });
  };
}

let cachedKeys: { issuer: string; keys: JWTVerifyGetKey } | undefined;

function keysFor(issuer: string): JWTVerifyGetKey {
  if (cachedKeys?.issuer !== issuer) {
    cachedKeys = {
      issuer,
      keys: createRemoteJWKSet(new URL('/cdn-cgi/access/certs', issuer), {
        [customFetch]: certsFetcher(),
      }),
    };
  }
  return cachedKeys.keys;
}

function accessConfiguration(
  env: AuthBindings,
):
  | Required<
      Pick<AuthBindings, 'ACCESS_ISSUER' | 'ACCESS_AUDIENCE' | 'OWNER_EMAIL'>
    >
  | Rejection {
  const { ACCESS_ISSUER, ACCESS_AUDIENCE, OWNER_EMAIL } = env;
  if (!ACCESS_ISSUER || !ACCESS_AUDIENCE || !OWNER_EMAIL) {
    const settings = (
      ['ACCESS_ISSUER', 'ACCESS_AUDIENCE', 'OWNER_EMAIL'] as const
    )
      .filter((name) => !env[name])
      .sort();
    return { reason: 'missing-config', settings };
  }
  if (!ACCESS_ISSUER.startsWith('https://'))
    return { reason: 'issuer-not-https' };
  return { ACCESS_ISSUER, ACCESS_AUDIENCE, OWNER_EMAIL };
}

export async function authenticate(
  request: Request,
  env: AuthBindings,
): Promise<Identity> {
  if (syntheticOwner(request, env))
    return { email: 'owner@nook.test', grant: 'all' };
  const config = accessConfiguration(env);
  if ('reason' in config) return { status: 401, ...config };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { status: 401, reason: 'no-assertion' };
  try {
    const { payload } = await jwtVerify(token, keysFor(config.ACCESS_ISSUER), {
      issuer: config.ACCESS_ISSUER,
      audience: config.ACCESS_AUDIENCE,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'email', 'sub'],
    });
    if (payload.email !== config.OWNER_EMAIL)
      return { status: 403, reason: 'not-owner' };
    return { email: config.OWNER_EMAIL, grant: 'all' };
  } catch (error) {
    // Never log the assertion, configured secrets, or a verifier error.
    return { status: 401, ...verifierRejection(error) };
  }
}
