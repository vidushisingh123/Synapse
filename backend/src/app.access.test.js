// Regression tests for the "signed-out user can see protected data" report.
// They drive the real Express app (real auth middleware, RBAC, JWT and password code) over HTTP.
// Only the graph, the agent and the user store are replaced by in-memory fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { createApp } from './app.js';
import { hashPassword } from './auth/password.js';
import { issueToken } from './auth/tokens.js';
import { PERMISSIONS, ROLE_PERMISSIONS } from './auth/rbac.js';
import { TOKEN_ISSUER, TOKEN_AUDIENCE } from './auth/config.js';

const SECRET = randomBytes(32).toString('hex');
const env = { JWT_SECRET: SECRET, NODE_ENV: 'test', GROQ_API_KEY: 'x' };
const silent = { warn() {}, error() {}, info() {}, log() {} };
const PASSWORD = 'correct horse battery staple';

// Matrix with an extra role that may invoke tools but NOT read offboarding data.
const matrix = {
  ...ROLE_PERMISSIONS,
  toolsonly: [PERMISSIONS.GRAPH_READ, PERMISSIONS.TOOLS_INVOKE, PERMISSIONS.INVESTIGATE],
};

let server;
let base;
let users;
let calls;

const userStore = {
  async findById(id) { return users.find((u) => u.id === id) ?? null; },
  async findByUsername(name) { return users.find((u) => u.username === name) ?? null; },
};

before(async () => {
  const passwordHash = await hashPassword(PASSWORD);
  const mk = (username, role, extra = {}) => ({ id: randomUUID(), username, role, passwordHash, disabled: false, ...extra });
  users = [mk('admin1', 'admin'), mk('analyst1', 'analyst'), mk('viewer1', 'viewer'), mk('lite1', 'toolsonly'), mk('off1', 'viewer', { disabled: true })];
  calls = { run: [], investigate: 0, snapshot: 0 };

  const tools = {
    TOOL_DEFINITIONS: [{ name: 'search_services' }],
    runTool: async (name) => { calls.run.push(name); return { ok: true }; },
    getGraphSnapshot: async () => { calls.snapshot += 1; return { nodes: [{ id: 'Service:x' }], edges: [] }; },
  };
  const investigateFn = async (question, { run }) => {
    calls.investigate += 1;
    if (question.includes('offboarding')) await run('get_offboarding_risk', {});
    return { report: { summary: 'SECRET-SUMMARY' }, evidence: [{ id: 'E1' }] };
  };

  const app = createApp({ userStore, tools, investigateFn, queryFn: async () => [{ nodes: 5 }], rolePermissions: matrix, env, logger: silent });
  await new Promise((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => new Promise((resolve) => server.close(resolve)));

const tokenFor = async (username) => (await issueToken(users.find((u) => u.username === username), { env })).token;
async function call(method, path, { token, body, headers } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}
const reset = () => { calls.run.length = 0; calls.investigate = 0; calls.snapshot = 0; };

test('signed-out requests to every protected or unknown /api route get 401 and reach no data', async () => {
  reset();
  const routes = [
    ['GET', '/api/graph'], ['GET', '/api/tools'], ['POST', '/api/tools/search_services', {}],
    ['POST', '/api/tools/get_offboarding_risk', {}], ['POST', '/api/investigate', { question: 'Why is checkout failing?' }],
    ['GET', '/api/history'], ['GET', '/api/investigations'], ['GET', '/api/investigations/1'],
    ['GET', '/api/evidence'], ['GET', '/api/evidence/E1'], ['GET', '/api/offboarding'], ['GET', '/api/auth/me'],
    ['GET', '/api/nope'], ['POST', '/api/auth/register', { username: 'mallory', password: PASSWORD }],
  ];
  for (const [method, path, body] of routes) {
    const r = await call(method, path, { body });
    assert.equal(r.status, 401, `${method} ${path} should be 401, got ${r.status}`);
    assert.equal(JSON.stringify(r.body).includes('SECRET'), false);
  }
  assert.deepEqual(calls, { run: [], investigate: 0, snapshot: 0 });
});

test('malformed, wrong-secret, unsigned and expired tokens are rejected', async () => {
  const good = await tokenFor('analyst1');
  const analyst = users.find((u) => u.username === 'analyst1');
  const forged = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(analyst.id)
    .setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE).setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(randomBytes(32).toString('hex')));
  const wrongAudience = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(analyst.id)
    .setIssuer(TOKEN_ISSUER).setAudience('someone-else').setIssuedAt().setExpirationTime('1h')
    .sign(new TextEncoder().encode(SECRET));
  const none = `${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: analyst.id })).toString('base64url')}.x`;
  const expired = (await issueToken(analyst, { env, nowMs: Date.now() - 2 * 3600 * 1000 })).token;

  for (const token of ['garbage', forged, wrongAudience, none, expired]) {
    const r = await call('GET', '/api/graph', { token });
    assert.equal(r.status, 401);
  }
  assert.equal((await call('GET', '/api/graph', { token: expired })).body.code, 'token_expired');
  assert.equal((await call('GET', '/api/graph', { token: good })).status, 200);
});

test('a disabled or deleted account loses access immediately, even with a still-valid token', async () => {
  const temp = { id: randomUUID(), username: 'temp1', role: 'analyst', passwordHash: 'x', disabled: false };
  users.push(temp);
  const { token } = await issueToken(temp, { env });
  assert.equal((await call('GET', '/api/graph', { token })).status, 200);
  temp.disabled = true;
  assert.equal((await call('GET', '/api/graph', { token })).status, 401);
  temp.disabled = false;
  users.splice(users.indexOf(temp), 1);
  assert.equal((await call('GET', '/api/graph', { token })).status, 401);
});

test('login: same response for unknown user, wrong password and disabled account; success returns a usable token', async () => {
  const unknown = await call('POST', '/api/auth/login', { body: { username: 'nobody', password: PASSWORD } });
  const wrong = await call('POST', '/api/auth/login', { body: { username: 'admin1', password: 'not the password!!' } });
  const disabled = await call('POST', '/api/auth/login', { body: { username: 'off1', password: PASSWORD } });
  for (const r of [unknown, wrong, disabled]) assert.equal(r.status, 401);
  assert.deepEqual(unknown.body, wrong.body);
  assert.deepEqual(unknown.body, disabled.body);

  const ok = await call('POST', '/api/auth/login', { body: { username: ' Admin1 ', password: PASSWORD } });
  assert.equal(ok.status, 200);
  assert.equal(ok.body.user.role, 'admin');
  assert.equal(ok.body.passwordHash, undefined);
  assert.equal((await call('GET', '/api/auth/me', { token: ok.body.token })).status, 200);
});

test('GET /api/auth/me reports the permissions of each role', async () => {
  const perms = async (u) => (await call('GET', '/api/auth/me', { token: await tokenFor(u) })).body.permissions;
  assert.deepEqual((await perms('viewer1')).sort(), ['graph:read']);
  assert.ok((await perms('analyst1')).includes('investigate'));
  assert.equal((await perms('analyst1')).includes('admin:users'), false);
  assert.ok((await perms('admin1')).includes('admin:users'));
});

test('health is minimal when signed out and detailed only with a valid token', async () => {
  const anon = await call('GET', '/api/health');
  assert.deepEqual(anon.body, { status: 'ok' });
  const withBadToken = await call('GET', '/api/health', { token: 'garbage' });
  assert.deepEqual(withBadToken.body, { status: 'ok' });
  const authed = await call('GET', '/api/health', { token: await tokenFor('viewer1') });
  assert.equal(authed.body.graph, 'synapse');
});

test('viewer can read the graph but cannot list/invoke tools or investigate', async () => {
  reset();
  const token = await tokenFor('viewer1');
  assert.equal((await call('GET', '/api/graph', { token })).status, 200);
  assert.equal((await call('GET', '/api/tools', { token })).status, 403);
  assert.equal((await call('POST', '/api/tools/search_services', { token, body: {} })).status, 403);
  assert.equal((await call('POST', '/api/tools/get_offboarding_risk', { token, body: {} })).status, 403);
  const inv = await call('POST', '/api/investigate', { token, body: { question: 'Why is checkout failing?' } });
  assert.equal(inv.status, 403);
  assert.equal(JSON.stringify(inv.body).includes('SECRET'), false);
  assert.deepEqual({ run: calls.run, investigate: calls.investigate }, { run: [], investigate: 0 });
});

test('analyst and admin can investigate and invoke tools', async () => {
  for (const u of ['analyst1', 'admin1']) {
    const token = await tokenFor(u);
    assert.equal((await call('GET', '/api/tools', { token })).status, 200);
    assert.equal((await call('POST', '/api/tools/search_services', { token, body: {} })).status, 200);
    assert.equal((await call('POST', '/api/tools/get_offboarding_risk', { token, body: {} })).status, 200);
    const inv = await call('POST', '/api/investigate', { token, body: { question: 'Why is checkout failing?' } });
    assert.equal(inv.status, 200);
  }
});

test('offboarding needs its own permission, on the HTTP endpoint and for the agent\'s tool calls', async () => {
  reset();
  const token = await tokenFor('lite1'); // may invoke tools, lacks offboarding:read
  assert.equal((await call('POST', '/api/tools/search_services', { token, body: {} })).status, 200);
  assert.equal((await call('POST', '/api/tools/get_offboarding_risk', { token, body: {} })).status, 403);
  // The agent runs with the caller's authority: an LLM-requested offboarding call is refused too.
  const inv = await call('POST', '/api/investigate', { token, body: { question: 'offboarding risk for Avery?' } });
  assert.equal(inv.status, 403);
  assert.equal(calls.run.includes('get_offboarding_risk'), false);
});

test('unknown tools, prototype-style names and bad questions are rejected for authorized users', async () => {
  const token = await tokenFor('analyst1');
  assert.equal((await call('POST', '/api/tools/does_not_exist', { token, body: {} })).status, 404);
  assert.equal((await call('POST', '/api/tools/__proto__', { token, body: {} })).status, 404);
  assert.equal((await call('POST', '/api/tools/constructor', { token, body: {} })).status, 404);
  assert.equal((await call('POST', '/api/investigate', { token, body: { question: 42 } })).status, 400);
  assert.equal((await call('POST', '/api/investigate', { token, body: { question: 'hi' } })).status, 400);
});
