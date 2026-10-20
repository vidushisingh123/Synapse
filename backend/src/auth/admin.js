import { hashPassword } from './password.js';
import { normalizeUsername, usernameError, passwordError } from './validation.js';

export class InputError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InputError';
  }
}

/** Validate, hash and store an admin account. Used by the CLI; there is no public registration. */
export async function createAdmin({ username, password, store }) {
  const name = normalizeUsername(username);
  const uErr = usernameError(name);
  if (uErr) throw new InputError(uErr);
  const pErr = passwordError(password, name);
  if (pErr) throw new InputError(pErr);
  const passwordHash = await hashPassword(password);
  return store.createUser({ username: name, passwordHash, role: 'admin' });
}
