import { Router } from 'express';
import { loadAuthConfig, AuthConfigError } from './config.js';
import { verifyPassword, verifyAgainstDummy } from './password.js';
import { issueToken } from './tokens.js';
import { normalizeUsername, PASSWORD_MAX } from './validation.js';
import { ROLE_PERMISSIONS, permissionsForRole } from './rbac.js';

const GENERIC_LOGIN_ERROR = 'Invalid username or password.';

export function createAuthRouter({ userStore, requireAuth, rolePermissions = ROLE_PERMISSIONS, env = process.env, logger = console }) {
  const router = Router();

  // PUBLIC: exchange credentials for a short-lived bearer token.
  router.post('/login', async (req, res) => {
    if (!loadAuthConfig(env).secret) throw new AuthConfigError();

    const username = normalizeUsername(req.body?.username);
    const password = req.body?.password;
    if (!username || username.length > 64 || typeof password !== 'string' || !password || password.length > PASSWORD_MAX) {
      return res.status(400).json({ error: 'Username and password are required.' });
    }

    const user = await userStore.findByUsername(username);
    let ok = false;
    if (user) ok = await verifyPassword(password, user.passwordHash);
    else await verifyAgainstDummy(password); // same work whether or not the account exists

    // Same response for: unknown user, wrong password, disabled account.
    if (!user || !ok || user.disabled) {
      logger.warn(`[auth] failed login attempt from ${req.ip}`);
      return res.status(401).json({ error: GENERIC_LOGIN_ERROR });
    }

    const { token, expiresIn } = await issueToken(user, { env });
    res.json({ token, tokenType: 'Bearer', expiresIn, user: { id: user.id, username: user.username, role: user.role } });
  });

  // PROTECTED (any authenticated user): who am I, and what may I do.
  // `permissions` is derived server-side from the stored role so the UI never has to guess;
  // it is informational only: every operation is still authorized on the server.
  router.get('/me', requireAuth, (req, res) => {
    res.json({ user: req.user, permissions: permissionsForRole(req.user.role, rolePermissions) });
  });

  return router;
}
