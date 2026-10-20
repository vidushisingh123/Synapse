import { verifyToken, TokenError } from './tokens.js';

// Strict "Bearer <header.payload.signature>" with three non-empty base64url segments.
const BEARER = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/i;

function unauthorized(res, code = 'unauthorized', message = 'Authentication required.') {
  return res.set('WWW-Authenticate', 'Bearer').status(401).json({ error: message, code });
}

/**
 * Resolves the bearer token on a request to a current, enabled user.
 * Returns { user } on success or { failure: 'missing'|'invalid'|'expired' }.
 * Config and store failures propagate as errors (never treated as "authenticated").
 */
async function resolveUser(req, userStore, env) {
  const header = req.get('authorization');
  if (!header) return { failure: 'missing' };
  const m = BEARER.exec(header.trim());
  if (!m) return { failure: 'invalid' };

  let sub;
  try {
    ({ sub } = await verifyToken(m[1], { env }));
  } catch (err) {
    if (err instanceof TokenError) return { failure: err.code };
    throw err;
  }

  // The user is re-read on every request, so deleted or disabled accounts lose access
  // immediately and no identity data is trusted from the token beyond its subject.
  const user = await userStore.findById(sub);
  if (!user || user.disabled) return { failure: 'invalid' };
  return { user: { id: user.id, username: user.username, role: user.role } };
}

export function createAuthMiddleware({ userStore, env = process.env, logger = console }) {
  /** Rejects with 401 unless the request carries a valid token for an enabled user. */
  async function requireAuth(req, res, next) {
    try {
      const r = await resolveUser(req, userStore, env);
      if (r.user) {
        req.user = r.user;
        return next();
      }
      if (r.failure === 'expired') return unauthorized(res, 'token_expired', 'Session expired. Please sign in again.');
      return unauthorized(res);
    } catch (err) {
      if (err?.name === 'AuthConfigError') return next(err);
      logger.error('[auth] could not verify credentials:', err?.message);
      return res.status(503).json({ error: 'Authentication service unavailable.' });
    }
  }

  /** Attaches req.user when a valid token is present; never rejects. For endpoints with a public view. */
  async function optionalAuth(req, _res, next) {
    try {
      const r = await resolveUser(req, userStore, env);
      if (r.user) req.user = r.user;
    } catch {
      /* treated as unauthenticated */
    }
    next();
  }

  return { requireAuth, optionalAuth };
}
