import { exportJWK, generateKeyPair, SignJWT } from 'jose';

export const access = {
  ACCESS_ISSUER: 'https://access.nook.test',
  ACCESS_AUDIENCE: 'nook-test',
  OWNER_EMAIL: 'owner@nook.test',
};

export async function accessFixture({
  issuer = access.ACCESS_ISSUER,
  algorithm = 'RS256',
}: {
  issuer?: string;
  algorithm?: 'RS256' | 'RS384' | 'RS512';
} = {}) {
  const key = await generateKeyPair(algorithm);
  const jwks = {
    keys: [{ ...(await exportJWK(key.publicKey)), kid: 'owner' }],
  };
  const fetched: string[] = [];
  return {
    fetched,
    async outboundService(request: Request) {
      fetched.push(request.url);
      return request.url === `${issuer}/cdn-cgi/access/certs`
        ? Response.json(jwks)
        : new Response('Unexpected outbound request', { status: 502 });
    },
    async assertion(
      claims: Record<string, unknown> = {},
      options: { signer?: CryptoKey; kid?: string } = {},
    ) {
      return new SignJWT({
        sub: 'synthetic-owner',
        email: access.OWNER_EMAIL,
        iss: issuer,
        aud: access.ACCESS_AUDIENCE,
        exp: Math.floor(Date.now() / 1000) + 300,
        ...claims,
      })
        .setProtectedHeader({ alg: algorithm, kid: options.kid ?? 'owner' })
        .sign(options.signer ?? key.privateKey);
    },
  };
}
