import { createRemoteJWKSet, jwtVerify } from 'jose';

const keySets = new Map();
export async function getIdentity(request, env, testKey) {
  const host = new URL(request.url).hostname;
  // Local development only; never accepted on Pages or a custom domain.
  if (['localhost', '127.0.0.1', '[::1]'].includes(host) && env.DEV_USER_EMAIL) {
    return { email: env.DEV_USER_EMAIL.toLowerCase(), sub: `dev:${env.DEV_USER_EMAIL.toLowerCase()}` };
  }
  const token = request.headers.get('Cf-Access-Jwt-Assertion');
  if (!token || !env.ACCESS_TEAM_DOMAIN || !env.ACCESS_AUD) throw new Error('Sign in to continue.');
  const issuer = `https://${env.ACCESS_TEAM_DOMAIN}`;
  if (!keySets.has(issuer)) keySets.set(issuer, createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`)));
  const { payload } = await jwtVerify(token, testKey || keySets.get(issuer), {
    issuer, audience: env.ACCESS_AUD, algorithms: ['RS256'], requiredClaims: ['exp', 'sub', 'email'],
  });
  if (payload.type !== 'app' || typeof payload.sub !== 'string' || !payload.sub ||
      typeof payload.email !== 'string' || !payload.email.includes('@')) throw new Error('Invalid login.');
  return { email: payload.email.toLowerCase(), sub: payload.sub };
}
