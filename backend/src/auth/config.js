// Authentication configuration, read from environment variables at call time.
// Nothing here ever returns, logs or embeds the secret value in a message.

export const TOKEN_ISSUER = 'synapse-api';
export const TOKEN_AUDIENCE = 'synapse-client';

const MIN_SECRET_LENGTH = 32;
const MIN_UNIQUE_CHARS = 10;
const PLACEHOLDER = /(change[-_ ]?me|replace[-_ ]?me|your[-_ ]?(jwt[-_ ]?)?secret|placeholder|example|password|default|insecure|todo)/i;

const DEFAULT_TTL_SECONDS = 3600;
const MIN_TTL_SECONDS = 60;
const MAX_TTL_SECONDS = 86_400;

export class AuthConfigError extends Error {
  constructor(message = 'Authentication is not configured.') {
    super(message);
    this.name = 'AuthConfigError';
    this.status = 503;
    this.expose = true;
  }
}

/** Returns a list of human-readable problems with a secret (never includes the secret itself). */
export function secretProblems(secret) {
  if (typeof secret !== 'string' || secret.trim() === '') return ['JWT_SECRET is not set'];
  const problems = [];
  if (secret.length < MIN_SECRET_LENGTH) problems.push(`JWT_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  if (new Set(secret).size < MIN_UNIQUE_CHARS) problems.push('JWT_SECRET has too little variety to be a random secret');
  if (PLACEHOLDER.test(secret)) problems.push('JWT_SECRET looks like a placeholder value');
  return problems;
}

export function loadAuthConfig(env = process.env) {
  const secret = typeof env.JWT_SECRET === 'string' && env.JWT_SECRET.trim() !== '' ? env.JWT_SECRET : null;
  const problems = secretProblems(env.JWT_SECRET);

  let ttlSeconds = DEFAULT_TTL_SECONDS;
  const rawTtl = env.JWT_EXPIRES_IN_SECONDS;
  if (rawTtl !== undefined && rawTtl !== '') {
    const n = Number(rawTtl);
    if (Number.isInteger(n) && n >= MIN_TTL_SECONDS && n <= MAX_TTL_SECONDS) ttlSeconds = n;
    else problems.push(`JWT_EXPIRES_IN_SECONDS must be an integer between ${MIN_TTL_SECONDS} and ${MAX_TTL_SECONDS}`);
  }
  return { secret, ttlSeconds, issuer: TOKEN_ISSUER, audience: TOKEN_AUDIENCE, problems };
}

/**
 * Call once at startup. In production a missing or insecure configuration is fatal.
 * Elsewhere it is reported loudly; with no secret at all, auth fails closed (no tokens issued or accepted).
 */
export function assertAuthConfig(env = process.env, logger = console) {
  const cfg = loadAuthConfig(env);
  if (cfg.problems.length) {
    const msg = `Invalid authentication configuration: ${cfg.problems.join('; ')}.`;
    if (env.NODE_ENV === 'production') throw new AuthConfigError(msg);
    logger.warn(`[auth] ${msg} Authentication will not work correctly until this is fixed.`);
  }
  return cfg;
}
