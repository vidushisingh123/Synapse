import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify, errors } from 'jose';
import { loadAuthConfig, AuthConfigError } from './config.js';

const ALG = 'HS256';
const keyOf = (secret) => new TextEncoder().encode(secret);

export class TokenError extends Error {
  constructor(code) {
    super(code === 'expired' ? 'Token expired.' : 'Invalid token.');
    this.name = 'TokenError';
    this.code = code; // 'expired' | 'invalid'
  }
}

/** Issues a short-lived HS256 token. The only identity claim is `sub` (the user id). */
export async function issueToken(user, { env = process.env, nowMs = Date.now() } = {}) {
  const cfg = loadAuthConfig(env);
  if (!cfg.secret) throw new AuthConfigError();
  const iat = Math.floor(nowMs / 1000);
  const token = await new SignJWT({})
    .setProtectedHeader({ alg: ALG, typ: 'JWT' })
    .setSubject(user.id)
    .setIssuer(cfg.issuer)
    .setAudience(cfg.audience)
    .setIssuedAt(iat)
    .setExpirationTime(iat + cfg.ttlSeconds)
    .setJti(randomUUID())
    .sign(keyOf(cfg.secret));
  return { token, expiresIn: cfg.ttlSeconds };
}

/** Verifies signature, algorithm, issuer, audience and expiry. Returns { sub }. */
export async function verifyToken(token, { env = process.env } = {}) {
  const cfg = loadAuthConfig(env);
  if (!cfg.secret) throw new AuthConfigError();
  try {
    const { payload } = await jwtVerify(token, keyOf(cfg.secret), {
      algorithms: [ALG],
      issuer: cfg.issuer,
      audience: cfg.audience,
      requiredClaims: ['sub', 'exp', 'iat'],
      clockTolerance: 5,
    });
    if (typeof payload.sub !== 'string' || !payload.sub) throw new TokenError('invalid');
    return { sub: payload.sub };
  } catch (err) {
    if (err instanceof TokenError) throw err;
    throw new TokenError(err instanceof errors.JWTExpired ? 'expired' : 'invalid');
  }
}
