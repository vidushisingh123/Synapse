const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,31}$/;
export const PASSWORD_MIN = 12;
export const PASSWORD_MAX = 128;

/** Trim + lowercase. Returns null if the value is not a string. */
export function normalizeUsername(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : null;
}

/** Returns an error message, or null when valid. Used when creating accounts. */
export function usernameError(username) {
  if (!username || !USERNAME_RE.test(username)) {
    return 'Username must be 3-32 characters: lowercase letters, digits, ".", "_" or "-", starting with a letter or digit.';
  }
  return null;
}

/** Returns an error message, or null when valid. Used when creating accounts (not at login). */
export function passwordError(password, username = '') {
  if (typeof password !== 'string') return 'Password is required.';
  if (password.length < PASSWORD_MIN) return `Password must be at least ${PASSWORD_MIN} characters.`;
  if (password.length > PASSWORD_MAX) return `Password must be at most ${PASSWORD_MAX} characters.`;
  if (password.trim() === '') return 'Password must not be only whitespace.';
  if (new Set(password).size < 4) return 'Password is too repetitive.';
  if (username && password.toLowerCase() === username.toLowerCase()) return 'Password must not equal the username.';
  return null;
}
