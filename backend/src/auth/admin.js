import { hashPassword } from './password.js';
import { normalizeUsername, usernameError, passwordError } from './validation.js';
import { isKnownRole } from './rbac.js';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/**
 * Validate, hash and store an account with the given role. Used by the CLI scripts only;
 * there is no public registration and no user-management API yet.
 */
export async function createAccount({ username, password, role, store }) {
  if (!isKnownRole(role)) throw new InputError('Role must be one of: admin, analyst, viewer.');
  const name = normalizeUsername(username);
  const uErr = usernameError(name);
  if (uErr) throw new InputError(uErr);
  const pErr = passwordError(password, name);
  if (pErr) throw new InputError(pErr);
  const passwordHash = await hashPassword(password);
  return store.createUser({ username: name, passwordHash, role });
}

/** Creates an admin account (unchanged behaviour). */
export const createAdmin = ({ username, password, store }) => createAccount({ username, password, role: 'admin', store });
