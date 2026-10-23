// Client-side session helpers. Everything here is a USABILITY aid: the backend enforces every
// restriction itself, so hiding or disabling a control never grants or removes real access.
//
// The token is kept in sessionStorage (cleared when the tab closes) under KEY. It is obtained from
// POST /api/auth/login by the login screen and verified with GET /api/auth/me before anything
// protected is rendered.
const KEY = 'synapse.token';
// Marks whose investigation history is saved in this browser, so another account never inherits it.
const OWNER_KEY = 'synapse.history.owner';

// Reading globalThis.localStorage can itself throw (site data blocked), so it is never used as a default argument.
const localStore = () => {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
};

export function getToken() {
  try {
    return globalThis.sessionStorage?.getItem(KEY) || null;
  } catch {
    return null;
  }
}

/** Returns false when the browser refused to store the token (e.g. storage disabled). */
export function setToken(token) {
  try {
    globalThis.sessionStorage.setItem(KEY, token);
    return true;
  } catch {
    return false;
  }
}

export function clearToken() {
  try {
    globalThis.sessionStorage?.removeItem(KEY);
  } catch {
    /* storage unavailable: nothing to clear */
  }
}

/** The account this browser's saved history belongs to (recorded by adoptHistoryOwner), or null. */
export function historyOwner(storage) {
  try {
    return (storage ?? localStore())?.getItem(OWNER_KEY) || null;
  } catch {
    return null;
  }
}

/**
 * Call after a session is verified and before any history is read. History saved in this browser
 * belongs to one account: if it was saved by someone else (or by an unknown owner, e.g. before
 * accounts were tied to history) it is wiped via `wipeHistory` rather than shown.
 */
export function adoptHistoryOwner(userId, wipeHistory, storage) {
  const id = String(userId);
  let previous = null;
  try {
    storage = storage ?? localStore();
    previous = storage?.getItem(OWNER_KEY) ?? null;
  } catch {
    /* unreadable: treat the owner as unknown */
  }
  if (previous !== id) wipeHistory();
  try {
    (storage ?? localStore())?.setItem(OWNER_KEY, id);
  } catch {
    /* if this cannot be stored, the next sign-in simply wipes again */
  }
}

/** Sign-out or authentication failure: forget the token, the saved history and its owner marker. */
export function endSession(wipeHistory, storage) {
  clearToken();
  try {
    wipeHistory();
  } finally {
    try {
      (storage ?? localStore())?.removeItem(OWNER_KEY);
    } catch {
      /* nothing to clear */
    }
  }
}

/** Error carrying the HTTP status so callers can tell 401 (not signed in) from 403 (not allowed). */
export class ApiError extends Error {
  constructor(message, status) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/** `me` is the body of GET /api/auth/me: { user, permissions }. Unknown/missing means no. */
export const can = (me, permission) => Array.isArray(me?.permissions) && me.permissions.includes(permission);
