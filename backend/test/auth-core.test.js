import test from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { hashPassword, verifyPassword, verifyAgainstDummy } from '../src/auth/password.js';
import { issueToken, verifyToken, TokenError } from '../src/auth/tokens.js';
import { assertAuthConfig, loadAuthConfig, AuthConfigError, TOKEN_ISSUER, TOKEN_AUDIENCE } from '../src/auth/config.js';
import { passwordError, usernameError, normalizeUsername } from '../src/auth/validation.js';
import { createUserStore, UserExistsError } from '../src/auth/users.js';
import { createAdmin, InputError } from '../src/auth/admin.js';
import { createMemoryUserStore } from './helpers/memory-user-store.js';
import { query, AUTH_GRAPH_NAME, GRAPH_NAME } from '../src/db.js';

const SECRET = 'k3J9vQ2mZr8LwT5nB1xYc7HdP0sFgA4uE6oIeR2tWqVbN9yMzXjCh';
const ENV = { JWT_SECRET: SECRET, NODE_ENV: 'test' };
const silent = { warn() {}, error() {}, info() {} };

// ── password hashing ──────────────────────────────────────────────────────────
test('password: hash is scrypt-formatted, salted, and contains no plaintext', async () => {
  const pw = 'correct horse battery staple';
  const a = await hashPassword(pw);
  const b = await hashPassword(pw);
  assert.match(a, /^scrypt\$\d+\$\d+\$\d+\$[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+$/);
  assert.notEqual(a, b, 'unique random salt per hash');
  assert.ok(!a.includes(pw));
});

test('password: verify accepts the right password and rejects wrong, empty and non-string input', async () => {
  const h = await hashPassword('correct horse battery staple');
  assert.equal(await verifyPassword('correct horse battery staple', h), true);
  assert.equal(await verifyPassword('correct horse battery stapl', h), false);
  assert.equal(await verifyPassword('', h), false);
  assert.equal(await verifyPassword(undefined, h), false);
  assert.equal(await verifyPassword({ toString: () => 'x' }, h), false);
});

test('password: malformed or tampered stored hashes verify as false instead of throwing', async () => {
  for (const bad of ['', 'plaintext', 'scrypt$x$y$z$a$b', 'bcrypt$1$2$3$4$5', 'scrypt$32768$8$1$$', 'scrypt$3$8$1$YQ==$YQ==', `scrypt$${2 ** 30}$8$1$YQ==$YQ==`, null, undefined]) {
    assert.equal(await verifyPassword('anything-at-all', bad), false);
  }
});

test('password: dummy verification never succeeds', async () => {
  assert.equal(await verifyAgainstDummy('whatever'), false);
});

// ── validation ────────────────────────────────────────────────────────────────
test('validation: usernames and passwords', () => {
  assert.equal(normalizeUsername('  Ada.L  '), 'ada.l');
  assert.equal(normalizeUsername(42), null);
  assert.equal(usernameError('ada'), null);
  for (const bad of ['', 'ab', '-ada', 'has space', 'a'.repeat(33), 'UPPER', 'semi;colon']) assert.ok(usernameError(bad), bad);
  assert.equal(passwordError('correct horse battery staple', 'ada'), null);
  assert.ok(passwordError('short'));
  assert.ok(passwordError('a'.repeat(129)));
  assert.ok(passwordError('            '));
  assert.ok(passwordError('aaaaaaaaaaaaaaaa'));
  assert.ok(passwordError('administrator1', 'administrator1'));
  assert.ok(passwordError(undefined));
});

// ── config ────────────────────────────────────────────────────────────────────
test('config: production fails when JWT_SECRET is missing, short, or a placeholder', () => {
  for (const secret of [undefined, '', '   ', 'short', 'change-me-change-me-change-me-change-me', 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa']) {
    assert.throws(
      () => assertAuthConfig({ NODE_ENV: 'production', JWT_SECRET: secret }, silent),
      (err) => err instanceof AuthConfigError && !String(err.message).includes(String(secret || '\u0000')),
      `secret ${JSON.stringify(secret)}`,
    );
  }
});

test('config: production accepts a strong secret; error text never contains the secret', () => {
  assert.doesNotThrow(() => assertAuthConfig({ NODE_ENV: 'production', JWT_SECRET: SECRET }, silent));
  try {
    assertAuthConfig({ NODE_ENV: 'production', JWT_SECRET: 'tooShortSecret' }, silent);
    assert.fail('should have thrown');
  } catch (err) {
    assert.ok(!err.message.includes('tooShortSecret'));
  }
});

test('config: outside production a bad secret only warns', () => {
  const warnings = [];
  assert.doesNotThrow(() => assertAuthConfig({ NODE_ENV: 'development' }, { warn: (m) => warnings.push(m) }));
  assert.equal(warnings.length, 1);
});

test('config: token lifetime is bounded and defaults sensibly', () => {
  assert.equal(loadAuthConfig({ JWT_SECRET: SECRET }).ttlSeconds, 3600);
  assert.equal(loadAuthConfig({ JWT_SECRET: SECRET, JWT_EXPIRES_IN_SECONDS: '900' }).ttlSeconds, 900);
  assert.ok(loadAuthConfig({ JWT_SECRET: SECRET, JWT_EXPIRES_IN_SECONDS: '999999999' }).problems.length > 0);
  assert.ok(loadAuthConfig({ JWT_SECRET: SECRET, JWT_EXPIRES_IN_SECONDS: 'abc' }).problems.length > 0);
});

// ── tokens ────────────────────────────────────────────────────────────────────
const key = new TextEncoder().encode(SECRET);
async function forge({ alg = 'HS256', secret = key, sub = 'user-1', iss = TOKEN_ISSUER, aud = TOKEN_AUDIENCE, iat, exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  let jwt = new SignJWT({}).setProtectedHeader({ alg }).setIssuedAt(iat ?? now).setExpirationTime(exp ?? now + 600);
  if (sub) jwt = jwt.setSubject(sub);
  if (iss) jwt = jwt.setIssuer(iss);
  if (aud) jwt = jwt.setAudience(aud);
  return jwt.sign(secret);
}

test('tokens: issued token verifies and carries only the subject identity', async () => {
  const { token, expiresIn } = await issueToken({ id: 'user-1' }, { env: ENV });
  assert.equal(expiresIn, 3600);
  assert.deepEqual(await verifyToken(token, { env: ENV }), { sub: 'user-1' });
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url'));
  assert.deepEqual(Object.keys(payload).sort(), ['aud', 'exp', 'iat', 'iss', 'jti', 'sub']);
});

test('tokens: expired, wrong-secret, wrong-issuer, wrong-audience, wrong-alg, missing-sub and garbage tokens are rejected', async () => {
  const now = Math.floor(Date.now() / 1000);
  const cases = {
    expired: [await forge({ iat: now - 7200, exp: now - 3600 }), 'expired'],
    wrongSecret: [await forge({ secret: new TextEncoder().encode('z'.repeat(40) + 'Q1w2E3r4') }), 'invalid'],
    wrongIssuer: [await forge({ iss: 'someone-else' }), 'invalid'],
    wrongAudience: [await forge({ aud: 'other-app' }), 'invalid'],
    wrongAlg: [await forge({ alg: 'HS512' }), 'invalid'],
    noSub: [await forge({ sub: null }), 'invalid'],
    garbage: ['not.a.jwt', 'invalid'],
  };
  for (const [name, [token, code]] of Object.entries(cases)) {
    await assert.rejects(() => verifyToken(token, { env: ENV }), (e) => e instanceof TokenError && e.code === code, name);
  }
});

test('tokens: unsigned (alg=none) token is rejected', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'user-1', iss: TOKEN_ISSUER, aud: TOKEN_AUDIENCE, iat: now, exp: now + 600 })}.`;
  await assert.rejects(() => verifyToken(none, { env: ENV }), TokenError);
});

test('tokens: no secret configured fails closed', async () => {
  await assert.rejects(() => issueToken({ id: 'u' }, { env: {} }), AuthConfigError);
  const { token } = await issueToken({ id: 'u' }, { env: ENV });
  await assert.rejects(() => verifyToken(token, { env: {} }), AuthConfigError);
});

// ── admin creation (CLI core) ─────────────────────────────────────────────────
test('createAdmin: validates input, stores only a hash, and rejects duplicates', async () => {
  const store = createMemoryUserStore();
  const user = await createAdmin({ username: ' Root.Admin ', password: 'correct horse battery staple', store });
  assert.equal(user.username, 'root.admin');
  assert.equal(user.role, 'admin');
  const rec = store.byName.get('root.admin');
  assert.ok(rec.passwordHash.startsWith('scrypt$'));
  assert.ok(!JSON.stringify(rec).includes('correct horse'));

  await assert.rejects(() => createAdmin({ username: 'root.admin', password: 'another long password!', store }), UserExistsError);
  await assert.rejects(() => createAdmin({ username: 'x', password: 'correct horse battery staple', store }), InputError);
  await assert.rejects(() => createAdmin({ username: 'valid.name', password: 'short', store }), InputError);
  await assert.rejects(() => createAdmin({ username: 'valid.name', password: undefined, store }), InputError);
});

// ── user store + db graph selection ───────────────────────────────────────────
test('user store: every query targets the auth graph, is parameterised, and findById never selects the hash', async () => {
  const calls = [];
  const queryFn = async (cypher, params, opts) => {
    calls.push({ cypher, params, opts });
    return [];
  };
  const store = createUserStore({ queryFn });
  await store.findByUsername("ada' OR 1=1 //");
  await store.findById('abc');
  assert.ok(calls.length === 2);
  for (const c of calls) {
    assert.equal(c.opts.graph, AUTH_GRAPH_NAME);
    assert.ok(!c.cypher.includes('OR 1=1'), 'user input must be passed as a parameter');
  }
  assert.ok(!calls[1].cypher.includes('passwordHash'));
  assert.equal(calls[0].params.username, "ada' OR 1=1 //");
});

test('user store: createUser reports an existing username via MERGE id mismatch', async () => {
  const store = createUserStore({ queryFn: async () => [{ id: 'someone-elses-id' }] });
  await assert.rejects(() => store.createUser({ username: 'ada', passwordHash: 'h', role: 'admin' }), UserExistsError);
  const ok = createUserStore({ queryFn: async (_c, p) => [{ id: p.id }] });
  const u = await ok.createUser({ username: 'ada', passwordHash: 'h', role: 'admin' });
  assert.equal(u.username, 'ada');
  await assert.rejects(() => ok.createUser({ username: 'ada', passwordHash: 'h', role: 'superuser' }), /Unknown role/);
});

test('db: auth graph is separate from the knowledge graph and unknown graphs are refused before connecting', async () => {
  assert.notEqual(AUTH_GRAPH_NAME, GRAPH_NAME);
  assert.equal(AUTH_GRAPH_NAME, 'synapse_auth');
  await assert.rejects(() => query('RETURN 1', {}, { graph: 'synapse; MATCH (n) DETACH DELETE n' }), /Unknown graph/);
});
