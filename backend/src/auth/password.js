import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

// Format: scrypt$N$r$p$<salt base64>$<hash base64>
const PARAMS = { N: 32_768, r: 8, p: 1 };
const KEY_LENGTH = 64;
const SALT_BYTES = 16;
// Stored parameters are bounded so a tampered record cannot force huge memory/CPU use.
const MAX_N = 2 ** 17;
const MAX_R = 16;
const MAX_P = 4;

const maxmemFor = (N, r) => 256 * N * r;

async function derive(password, salt, { N, r, p }, keyLength) {
  return scryptAsync(password, salt, keyLength, { N, r, p, maxmem: maxmemFor(N, r) });
}

export async function hashPassword(password) {
  if (typeof password !== 'string' || password.length === 0) throw new TypeError('Password must be a non-empty string.');
  const salt = randomBytes(SALT_BYTES);
  const key = await derive(password, salt, PARAMS, KEY_LENGTH);
  return ['scrypt', PARAMS.N, PARAMS.r, PARAMS.p, salt.toString('base64'), key.toString('base64')].join('$');
}

/** Constant-time verification. Returns false (never throws) for malformed input or records. */
export async function verifyPassword(password, stored) {
  try {
    if (typeof password !== 'string' || typeof stored !== 'string') return false;
    const [scheme, n, r, p, saltB64, hashB64] = stored.split('$');
    if (scheme !== 'scrypt' || !hashB64) return false;
    const params = { N: Number(n), r: Number(r), p: Number(p) };
    const ok =
      Number.isInteger(params.N) && params.N >= 2 && params.N <= MAX_N && (params.N & (params.N - 1)) === 0 &&
      Number.isInteger(params.r) && params.r >= 1 && params.r <= MAX_R &&
      Number.isInteger(params.p) && params.p >= 1 && params.p <= MAX_P;
    if (!ok) return false;
    const salt = Buffer.from(saltB64, 'base64');
    const expected = Buffer.from(hashB64, 'base64');
    if (!salt.length || !expected.length) return false;
    const actual = await derive(password, salt, params, expected.length);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  } catch {
    return false;
  }
}

let dummyHash;
/**
 * Burns the same CPU as a real check. Used when the username does not exist so response
 * time does not reveal whether an account exists.
 */
export async function verifyAgainstDummy(password) {
  dummyHash ??= await hashPassword(randomBytes(24).toString('base64'));
  await verifyPassword(typeof password === 'string' ? password : '', dummyHash);
  return false;
}
