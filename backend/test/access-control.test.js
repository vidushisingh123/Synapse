// Server-side access control, exercised on the REAL rbac.js / middleware.js / tokens.js with fake
// request/response objects (no Express, FalkorDB or Groq needed). Nothing here trusts the frontend.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import {
  PERMISSIONS as P, ROLE_PERMISSIONS, TOOL_PERMISSIONS, permissionsForRole, hasPermission,
  authorizeTool, createAuthorizedRun, requirePermission, ForbiddenError, UnknownToolError,
} from '../src/auth/rbac.js';
import { createAuthMiddleware } from '../src/auth/middleware.js';
import { issueToken } from '../src/auth/tokens.js';
import { TOOLS } from '../src/graph/tools.js';

const env = { JWT_SECRET: 'q7Vx2Lm9Zt4Rb8Kd1Wn6Fc3Hs0Yg5Ju-unit-test-only' };
const quiet = { warn() {}, error() {}, log() {} };
const NOW = Math.floor(Date.now() / 1000);

const USERS = {
  admin: { id: 'u-admin', username: 'root', role: 'admin', disabled: false },
  analyst: { id: 'u-analyst', username: 'ann', role: 'analyst', disabled: false },
  viewer: { id: 'u-viewer', username: 'vic', role: 'viewer', disabled: false },
  off: { id: 'u-off', username: 'off', role: 'analyst', disabled: true },
};
const makeStore = (users = USERS) => ({ findById: async (id) => Object.values(users).find((u) => u.id === id) ?? null });

function mockRes() {
  const res = { statusCode: 200, headers: {}, body: undefined, onSend: null,
    set(k, v) { this.headers[k] = v; return this; }, status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; this.onSend?.(); return this; } };
  return res;
}
const mockReq = (headers = {}, extra = {}) => ({ get: (n) => headers[n.toLowerCase()], method: 'GET', path: '/x', ...extra });
function run(mw, req) {
  return new Promise((resolve, reject) => {
    const res = mockRes();
    res.onSend = () => resolve({ res, next: false });
    Promise.resolve(mw(req, res, (err) => resolve({ res, next: true, err }))).catch(reject);
  });
}
const bearer = (t) => ({ authorization: `Bearer ${t}` });
const tokenFor = async (u, opts = {}) => (await issueToken(u, { env, ...opts })).token;

// ---------------------------------------------------------------- role / permission matrix
test('role matrix: viewer can only read the graph; analyst cannot administer; unknown roles hold nothing', () => {
  assert.deepEqual(permissionsForRole('viewer'), [P.GRAPH_READ]);
  assert.ok(!hasPermission('viewer', P.INVESTIGATE) && !hasPermission('viewer', P.TOOLS_INVOKE) && !hasPermission('viewer', P.OFFBOARDING_READ));
  for (const p of [P.GRAPH_READ, P.TOOLS_INVOKE, P.INVESTIGATE, P.OFFBOARDING_READ]) assert.ok(hasPermission('analyst', p), p);
  assert.ok(!hasPermission('analyst', P.ADMIN_USERS));
  for (const p of Object.values(P)) assert.ok(hasPermission('admin', p), p);
  for (const r of ['root', '', null, undefined, '__proto__', 'constructor', 'toString', 'ADMIN']) assert.deepEqual(permissionsForRole(r), [], String(r));
  assert.ok(Object.isFrozen(ROLE_PERMISSIONS) && Object.isFrozen(ROLE_PERMISSIONS.viewer));
});

test('every graph tool has a permission mapping, and nothing maps to a tool that does not exist', () => {
  assert.deepEqual(Object.keys(TOOL_PERMISSIONS).sort(), Object.keys(TOOLS).sort());
});

test('viewer is forbidden from every tool; analyst and admin may use all of them', () => {
  for (const name of Object.keys(TOOLS)) {
    assert.throws(() => authorizeTool(USERS.viewer, name, { logger: quiet }), ForbiddenError, name);
    assert.doesNotThrow(() => authorizeTool(USERS.analyst, name, { logger: quiet }), name);
    assert.doesNotThrow(() => authorizeTool(USERS.admin, name, { logger: quiet }), name);
  }
});

test('offboarding data needs its own permission on top of tools:invoke', () => {
  const noOffboarding = { analyst: [P.GRAPH_READ, P.TOOLS_INVOKE, P.INVESTIGATE] };
  const opts = { matrix: noOffboarding, logger: quiet };
  assert.throws(() => authorizeTool(USERS.analyst, 'get_offboarding_risk', opts), ForbiddenError);
  assert.doesNotThrow(() => authorizeTool(USERS.analyst, 'get_engineers', opts));
});

test('unknown tools (including prototype names) are rejected for everyone, even admin', () => {
  for (const name of ['nope', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', undefined, null, 42]) {
    assert.throws(() => authorizeTool(USERS.admin, name, { logger: quiet }), UnknownToolError, String(name));
  }
});

test('createAuthorizedRun never reaches the tool when authorization fails', async () => {
  let calls = 0;
  const runner = async () => { calls++; return 'data'; };
  await assert.rejects(createAuthorizedRun(USERS.viewer, runner, { logger: quiet })('search_services', {}), ForbiddenError);
  await assert.rejects(createAuthorizedRun(undefined, runner, { logger: quiet })('search_services', {}), ForbiddenError);
  await assert.rejects(createAuthorizedRun(USERS.admin, runner, { logger: quiet })('constructor', {}), UnknownToolError);
  assert.equal(calls, 0);
  assert.equal(await createAuthorizedRun(USERS.analyst, runner, { logger: quiet })('search_services', {}), 'data');
  assert.equal(calls, 1);
});

test('requirePermission: no principal -> 401; wrong role -> 403; right role -> next', async () => {
  const need = (p) => requirePermission(p, { logger: quiet });
  let r = await run(need(P.GRAPH_READ), mockReq());
  assert.equal(r.res.statusCode, 401); assert.equal(r.res.headers['WWW-Authenticate'], 'Bearer'); assert.equal(r.next, false);
  for (const perm of [P.INVESTIGATE, P.TOOLS_INVOKE]) {
    r = await run(need(perm), mockReq({}, { user: USERS.viewer }));
    assert.equal(r.res.statusCode, 403, perm); assert.equal(r.next, false);
  }
  assert.equal((await run(need(P.GRAPH_READ), mockReq({}, { user: USERS.viewer }))).next, true);
  assert.equal((await run(need(P.INVESTIGATE), mockReq({}, { user: USERS.analyst }))).next, true);
  assert.throws(() => requirePermission('graph:write'), /Unknown permission/);
});

// ---------------------------------------------------------------- authentication middleware
const authMw = (users) => createAuthMiddleware({ userStore: makeStore(users), env, logger: quiet });

test('requireAuth: missing, malformed or non-bearer credentials -> 401 and no principal', async () => {
  const { requireAuth } = authMw();
  for (const headers of [{}, { authorization: '' }, { authorization: 'Basic dXNlcjpwYXNz' }, bearer('not-a-jwt'), bearer('a.b'), bearer('a.b.c.d'), { authorization: 'Bearer ' }]) {
    const req = mockReq(headers);
    const r = await run(requireAuth, req);
    assert.equal(r.res.statusCode, 401, JSON.stringify(headers)); assert.equal(r.next, false); assert.equal(req.user, undefined);
  }
});

test('requireAuth: forged, tampered, wrong-secret and wrong-audience tokens are rejected', async () => {
  const { requireAuth } = authMw();
  const good = await tokenFor(USERS.viewer);
  const [h, , s] = good.split('.');
  const forgedPayload = Buffer.from(JSON.stringify({ sub: USERS.admin.id, iss: 'synapse-api', aud: 'synapse-client', iat: 1, exp: 9999999999 })).toString('base64url');
  const wrongSecret = await tokenFor(USERS.viewer, { env: { JWT_SECRET: 'Zk4Ws8Qp1Nv6Bt3Hx9Lc2Rm7Fd0Jg5Ya-other-secret' } });
  const wrongAud = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(USERS.admin.id)
    .setIssuer('synapse-api').setAudience('someone-else').setIssuedAt(NOW).setExpirationTime(NOW + 3600).sign(new TextEncoder().encode(env.JWT_SECRET));
  for (const t of [`${h}.${forgedPayload}.${s}`, wrongSecret, wrongAud]) {
    const req = mockReq(bearer(t));
    const r = await run(requireAuth, req);
    assert.equal(r.res.statusCode, 401); assert.equal(req.user, undefined);
  }
});

test('requireAuth: expired tokens get a distinct "token_expired" code', async () => {
  const { requireAuth } = authMw();
  const old = await tokenFor(USERS.analyst, { nowMs: Date.now() - 3 * 3600 * 1000 });
  const r = await run(requireAuth, mockReq(bearer(old)));
  assert.equal(r.res.statusCode, 401); assert.equal(r.res.body.code, 'token_expired');
});

test('requireAuth: tokens for deleted or disabled accounts stop working immediately', async () => {
  const { requireAuth } = authMw();
  const ghost = await tokenFor({ id: 'u-ghost' });
  assert.equal((await run(requireAuth, mockReq(bearer(ghost)))).res.statusCode, 401);
  const disabled = await tokenFor(USERS.off);
  assert.equal((await run(requireAuth, mockReq(bearer(disabled)))).res.statusCode, 401);
});

test('requireAuth: a valid token yields the stored user only (no password hash); role comes from the store, not the token', async () => {
  const store = { ...USERS, viewer: { ...USERS.viewer, passwordHash: 'scrypt$secret' } };
  const { requireAuth } = authMw(store);
  const req = mockReq(bearer(await tokenFor(USERS.viewer)));
  assert.equal((await run(requireAuth, req)).next, true);
  assert.deepEqual(req.user, { id: 'u-viewer', username: 'vic', role: 'viewer' });

  // A correctly signed token that CLAIMS admin must not elevate a viewer.
  const forged = await new SignJWT({ role: 'admin', permissions: ['admin:users'] }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(USERS.viewer.id).setIssuer('synapse-api').setAudience('synapse-client').setIssuedAt(NOW).setExpirationTime(NOW + 3600)
    .sign(new TextEncoder().encode(env.JWT_SECRET));
  const req2 = mockReq(bearer(forged));
  await run(requireAuth, req2);
  assert.equal(req2.user.role, 'viewer');
  assert.ok(!hasPermission(req2.user.role, P.INVESTIGATE));

  // A role change (or demotion) applies to tokens already issued, because the user is re-read every request.
  const live = { ...USERS, analyst: { ...USERS.analyst } };
  const mw = authMw(live).requireAuth;
  const tok = await tokenFor(USERS.analyst);
  const a = mockReq(bearer(tok)); await run(mw, a); assert.equal(a.user.role, 'analyst');
  live.analyst.role = 'viewer';
  const b = mockReq(bearer(tok)); await run(mw, b); assert.equal(b.user.role, 'viewer');
});

test('requireAuth fails closed when the user store or the JWT secret is unavailable', async () => {
  const brokenStore = createAuthMiddleware({ userStore: { findById: async () => { throw new Error('db down'); } }, env, logger: quiet });
  const req = mockReq(bearer(await tokenFor(USERS.admin)));
  const r = await run(brokenStore.requireAuth, req);
  assert.equal(r.res.statusCode, 503); assert.equal(req.user, undefined); assert.equal(r.next, false);

  const noSecret = createAuthMiddleware({ userStore: makeStore(), env: {}, logger: quiet });
  const req2 = mockReq(bearer(await tokenFor(USERS.admin)));
  const r2 = await run(noSecret.requireAuth, req2);
  assert.equal(r2.next, true); assert.equal(r2.err?.name, 'AuthConfigError'); assert.equal(req2.user, undefined);
});

test('optionalAuth never rejects and only attaches a principal for a valid token', async () => {
  const { optionalAuth } = authMw();
  const anon = mockReq(bearer('garbage'));
  assert.equal((await run(optionalAuth, anon)).next, true); assert.equal(anon.user, undefined);
  const authed = mockReq(bearer(await tokenFor(USERS.viewer)));
  await run(optionalAuth, authed); assert.equal(authed.user.id, 'u-viewer');
});
