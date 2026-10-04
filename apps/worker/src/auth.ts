import {
  createRemoteJWKSet,
  customFetch,
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

type Identity = { email: string } | { status: 401 | 403 };

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

function configured(
  env: AuthBindings,
): env is Required<
  Pick<AuthBindings, 'ACCESS_ISSUER' | 'ACCESS_AUDIENCE' | 'OWNER_EMAIL'>
> {
  return Boolean(
    env.ACCESS_ISSUER?.startsWith('https://') &&
      env.ACCESS_AUDIENCE &&
      env.OWNER_EMAIL,
  );
}

export async function authenticate(
  request: Request,
  env: AuthBindings,
): Promise<Identity> {
  if (syntheticOwner(request, env)) return { email: 'owner@nook.test' };
  if (!configured(env)) return { status: 401 };
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token) return { status: 401 };
  try {
    const { payload } = await jwtVerify(token, keysFor(env.ACCESS_ISSUER), {
      issuer: env.ACCESS_ISSUER,
      audience: env.ACCESS_AUDIENCE,
      algorithms: ['RS256'],
      requiredClaims: ['exp', 'email', 'sub'],
    });
    if (payload.email !== env.OWNER_EMAIL) return { status: 403 };
    return { email: env.OWNER_EMAIL };
  } catch {
    // Never log the assertion, configured secrets, or a verifier error.
    return { status: 401 };
  }
}
