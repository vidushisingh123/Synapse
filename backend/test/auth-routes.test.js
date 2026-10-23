// HTTP-level route policy: login, session check and every protected route, over a real Express app.
// Needs the project's real dependencies (express, cors, jose) and src/auth/validation.js; run with `npm test`
// after `npm install`. FalkorDB and Groq are NOT needed: users, tools and the agent are injected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { issueToken } from '../src/auth/tokens.js';
import { hashPassword } from '../src/auth/password.js';

const env = { JWT_SECRET: 'q7Vx2Lm9Zt4Rb8Kd1Wn6Fc3Hs0Yg5Ju-route-test-only', NODE_ENV: 'test' };
const PASSWORD = 'correct horse battery 7!';
const quiet = { warn() {}, error() {}, log() {} };

let server, base, hash;
const users = {};
const calls = { tools: 0, investigate: 0 };
const NOW = () => Math.floor(Date.now() / 1000);

before(async () => {
  hash = await hashPassword(PASSWORD);
  Object.assign(users, {
    admin: { id: 'u-admin', username: 'root', role: 'admin', disabled: false, passwordHash: hash },
    analyst: { id: 'u-analyst', username: 'ann', role: 'analyst', disabled: false, passwordHash: hash },
    viewer: { id: 'u-viewer', username: 'vic', role: 'viewer', disabled: false, passwordHash: hash },
    off: { id: 'u-off', username: 'off', role: 'analyst', disabled: true, passwordHash: hash },
  });
  const all = () => Object.values(users);
  const userStore = {
    findById: async (id) => all().find((u) => u.id === id) ?? null,
    findByUsername: async (name) => all().find((u) => u.username === name) ?? null,
  };
  const app = createApp({
    userStore, env, logger: quiet,
    queryFn: async () => [{ nodes: 3 }],
    tools: {
      TOOL_DEFINITIONS: [{ name: 'search_services' }],
      runTool: async () => { calls.tools++; return { services: ['Checkout API'] }; },
      getGraphSnapshot: async () => ({ nodes: [{ id: 'Service:Checkout API', label: 'Service', name: 'Checkout API' }], edges: [] }),
    },
    investigateFn: async (q) => { calls.investigate++; return { mode: 'graph-only', report: { summary: `answer to ${q}` }, evidence: [] }; },
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => server?.close());

const tokenFor = async (u, opts) => (await issueToken(u, { env, ...opts })).token;
async function call(method, path, { token, body } = {}) {
  const headers = { ...(body ? { 'content-type': 'application/json' } : {}), ...(token ? { authorization: `Bearer ${token}` } : {}) };
  const res = await fetch(`${base}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
}

const PROTECTED = [
  ['GET', '/api/graph'], ['GET', '/api/tools'],
  ['POST', '/api/tools/search_services'], ['POST', '/api/tools/get_offboarding_risk'],
  ['POST', '/api/investigate'],
  // There is no investigation history/detail endpoint; these must never serve data to anyone unauthenticated.
  ['GET', '/api/investigations'], ['GET', '/api/investigations/abc123'], ['GET', '/api/history'],
  ['GET', '/api/evidence/E1'], ['GET', '/api/offboarding/Avery%20Chen'], ['GET', '/api/does-not-exist'],
  ['GET', '/api/auth/me'],
];

test('unauthenticated: every data route answers 401 with no data, and nothing is cacheable', async () => {
  const before = { ...calls };
  for (const [method, path] of PROTECTED) {
    const r = await call(method, path, { body: method === 'POST' ? { question: 'Why is Checkout slow?' } : undefined });
    assert.equal(r.status, 401, `${method} ${path}`);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
    assert.deepEqual(Object.keys(r.json).sort(), ['code', 'error'], `${method} ${path} leaked fields`);
    assert.equal(r.headers.get('cache-control'), 'no-store');
  }
  assert.deepEqual(calls, before, 'no tool or investigation ran for an unauthenticated caller');
});

test('invalid, tampered, expired and wrong-secret tokens are rejected on protected routes', async () => {
  const good = await tokenFor(users.viewer);
  const [h, , s] = good.split('.');
  const forged = `${h}.${Buffer.from(JSON.stringify({ sub: 'u-admin', iss: 'synapse-api', aud: 'synapse-client', iat: 1, exp: 9999999999 })).toString('base64url')}.${s}`;
  const wrongSecret = (await issueToken(users.viewer, { env: { JWT_SECRET: 'Zk4Ws8Qp1Nv6Bt3Hx9Lc2Rm7Fd0Jg5Ya-other-secret' } })).token;
  for (const token of ['garbage', good.slice(0, -3) + 'abc', forged, wrongSecret]) {
    assert.equal((await call('GET', '/api/graph', { token })).status, 401);
  }
  const expired = await call('GET', '/api/graph', { token: await tokenFor(users.analyst, { nowMs: Date.now() - 3 * 3600 * 1000 }) });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 'token_expired');
});

test('health is public but minimal; details need a valid token', async () => {
  const anon = await call('GET', '/api/health');
  assert.equal(anon.status, 200);
  assert.deepEqual(Object.keys(anon.json), ['status']);
  const authed = await call('GET', '/api/health', { token: await tokenFor(users.viewer) });
  assert.equal(authed.json.nodes, 3);
});

test('login: bad input 400; unknown user, wrong password and disabled account are indistinguishable 401s', async () => {
  assert.equal((await call('POST', '/api/auth/login', { body: {} })).status, 400);
  assert.equal((await call('POST', '/api/auth/login', { body: { username: 'vic' } })).status, 400);
  const unknown = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: PASSWORD } });
  const wrong = await call('POST', '/api/auth/login', { body: { username: 'vic', password: 'not the password' } });
  const disabled = await call('POST', '/api/auth/login', { body: { username: 'off', password: PASSWORD } });
  for (const r of [unknown, wrong, disabled]) assert.equal(r.status, 401);
  assert.deepEqual(unknown.json, wrong.json);
  assert.deepEqual(unknown.json, disabled.json);
  assert.ok(!('token' in unknown.json));
});

test('login returns a token and the user (never the password hash); /me reflects the stored role', async () => {
  for (const [name, role, perms] of [['vic', 'viewer', ['graph:read']], ['ann', 'analyst', null], ['root', 'admin', null]]) {
    const login = await call('POST', '/api/auth/login', { body: { username: name, password: PASSWORD } });
    assert.equal(login.status, 200, name);
    assert.equal(login.json.tokenType, 'Bearer');
    assert.deepEqual(login.json.user, { id: users[role].id, username: name, role });
    assert.ok(!JSON.stringify(login.json).includes('scrypt$'));
    const me = await call('GET', '/api/auth/me', { token: login.json.token });
    assert.equal(me.status, 200);
    assert.equal(me.json.user.role, role);
    if (perms) assert.deepEqual(me.json.permissions, perms);
  }
});

test('viewer: may read the graph, but cannot invoke tools, offboarding data or investigations', async () => {
  const token = await tokenFor(users.viewer);
  const before = { ...calls };
  assert.equal((await call('GET', '/api/graph', { token })).status, 200);
  assert.equal((await call('GET', '/api/tools', { token })).status, 403);
  assert.equal((await call('POST', '/api/tools/search_services', { token, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/tools/get_offboarding_risk', { token, body: { engineer: 'Avery Chen' } })).status, 403);
  assert.equal((await call('POST', '/api/investigate', { token, body: { question: 'Why is Checkout API slow?' } })).status, 403);
  assert.deepEqual(calls, before, 'denied requests must not reach the tools or the agent');
});

test('analyst and admin may run tools and investigations; unknown tools stay unknown', async () => {
  for (const u of [users.analyst, users.admin]) {
    const token = await tokenFor(u);
    assert.equal((await call('GET', '/api/tools', { token })).status, 200);
    assert.equal((await call('POST', '/api/tools/search_services', { token, body: {} })).status, 200);
    const inv = await call('POST', '/api/investigate', { token, body: { question: 'Why is Checkout API slow?' } });
    assert.equal(inv.status, 200);
    assert.match(inv.json.report.summary, /Checkout API/);
    assert.equal((await call('POST', '/api/tools/not_a_tool', { token, body: {} })).status, 404);
    assert.equal((await call('POST', '/api/tools/constructor', { token, body: {} })).status, 404);
  }
});

test('a token that claims a higher role does not elevate; role changes and disabling apply to live tokens', async () => {
  const claimsAdmin = await new SignJWT({ role: 'admin' }).setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .setSubject(users.viewer.id).setIssuer('synapse-api').setAudience('synapse-client')
    .setIssuedAt(NOW()).setExpirationTime(NOW() + 3600).sign(new TextEncoder().encode(env.JWT_SECRET));
  assert.equal((await call('POST', '/api/investigate', { token: claimsAdmin, body: { question: 'Why is Checkout API slow?' } })).status, 403);

  const token = await tokenFor(users.analyst);
  assert.equal((await call('POST', '/api/investigate', { token, body: { question: 'Why is Checkout API slow?' } })).status, 200);
  users.analyst.role = 'viewer';
  assert.equal((await call('POST', '/api/investigate', { token, body: { question: 'Why is Checkout API slow?' } })).status, 403);
  users.analyst.role = 'analyst';
  users.analyst.disabled = true;
  assert.equal((await call('GET', '/api/graph', { token })).status, 401);
  users.analyst.disabled = false;
});

test('investigation IDs grant nothing: the server has no history/detail endpoint, even for an authenticated admin', async () => {
  const token = await tokenFor(users.admin);
  for (const path of ['/api/investigations', '/api/investigations/abc123', '/api/history', '/api/investigations/abc123/evidence']) {
    const r = await call('GET', path, { token });
    assert.equal(r.status, 404, path);
    assert.deepEqual(r.json, { error: 'Not found' });
  }
});

test('investigate input validation: non-string and out-of-range questions are 400s', async () => {
  const token = await tokenFor(users.analyst);
  for (const question of [undefined, 12345, ['a', 'b', 'c'], { x: 1 }, '  hi ', 'x'.repeat(501)]) {
    assert.equal((await call('POST', '/api/investigate', { token, body: { question } })).status, 400, JSON.stringify(question)?.slice(0, 20));
  }
});
