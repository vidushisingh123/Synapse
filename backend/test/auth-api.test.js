import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { createAdmin } from '../src/auth/admin.js';
import { TOKEN_ISSUER, TOKEN_AUDIENCE } from '../src/auth/config.js';
import { createMemoryUserStore } from './helpers/memory-user-store.js';

const SECRET = 'k3J9vQ2mZr8LwT5nB1xYc7HdP0sFgA4uE6oIeR2tWqVbN9yMzXjCh';
const PASSWORD = 'correct horse battery staple';
const key = new TextEncoder().encode(SECRET);

const logs = { warn: [], error: [] };
const logger = { info() {}, warn: (...a) => logs.warn.push(a.join(' ')), error: (...a) => logs.error.push(a.map(String).join(' ')) };

// Stubs stand in for FalkorDB/Groq so the HTTP layer is tested on its own.
const SNAPSHOT = { nodes: [{ id: 'Service:Checkout API', label: 'Service', name: 'Checkout API' }], edges: [] };
const DEFS = [{ name: 'search_services', description: 'x', input_schema: { type: 'object' } }];
const INVESTIGATION = { mode: 'graph-only', warning: null, report: { summary: 's', facts: [] }, evidence: [] };

const store = createMemoryUserStore();
let base;
let server;
let admin;

function listen(app) {
  return new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
}
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const close = (s) => new Promise((r) => s.close(r));

function makeApp(overrides = {}) {
  return createApp({
    userStore: store,
    tools: { TOOL_DEFINITIONS: DEFS, runTool: async (name, input) => ({ name, input }), getGraphSnapshot: async () => SNAPSHOT },
    investigateFn: async () => INVESTIGATION,
    queryFn: async () => [{ nodes: 12 }],
    env: { JWT_SECRET: SECRET, NODE_ENV: 'test', GROQ_API_KEY: 'configured-but-fake' },
    logger,
    ...overrides,
  });
}

before(async () => {
  admin = await createAdmin({ username: 'ada', password: PASSWORD, store });
  server = await listen(makeApp());
  base = urlOf(server);
});
after(() => close(server));

async function call(path, { method = 'GET', token, headers = {}, body, rawBody, origin = base } = {}) {
  const res = await fetch(origin + path, {
    method,
    headers: { ...(body !== undefined || rawBody !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: rawBody ?? (body !== undefined ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, headers: res.headers, text, json };
}

async function login(username = 'ada', password = PASSWORD) {
  return call('/api/auth/login', { method: 'POST', body: { username, password } });
}
async function validToken() {
  const r = await login();
  assert.equal(r.status, 200);
  return r.json.token;
}
async function forge({ sub = admin.id, iat, exp } = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(iat ?? now).setExpirationTime(exp ?? now + 600).sign(key);
}

// ── login ─────────────────────────────────────────────────────────────────────
test('login: valid credentials return a bearer token and the public user', async () => {
  const r = await login();
  assert.equal(r.status, 200);
  assert.equal(r.json.tokenType, 'Bearer');
  assert.equal(r.json.expiresIn, 3600);
  assert.equal(r.json.token.split('.').length, 3);
  assert.deepEqual(r.json.user, { id: admin.id, username: 'ada', role: 'admin' });
});

test('login: username is case-insensitive and trimmed', async () => {
  assert.equal((await login('  ADA ')).status, 200);
});

test('login: wrong password, unknown user and disabled account give the same generic 401 and no token', async () => {
  store.byName.get('ada').disabled = false;
  const wrong = await login('ada', 'not the right password');
  const unknown = await login('nobody.here', PASSWORD);
  store.byName.get('ada').disabled = true;
  const disabled = await login('ada', PASSWORD);
  store.byName.get('ada').disabled = false;

  for (const r of [wrong, unknown, disabled]) {
    assert.equal(r.status, 401);
    assert.ok(!('token' in r.json));
  }
  assert.equal(wrong.text, unknown.text, 'unknown user must be indistinguishable from a wrong password');
  assert.equal(wrong.text, disabled.text);
  assert.deepEqual(wrong.json, { error: 'Invalid username or password.' });
});

test('login: failed attempts are logged server-side without the username or password', async () => {
  logs.warn.length = 0;
  await login('probe.user', 'hunter2hunter2');
  assert.ok(logs.warn.some((l) => l.includes('failed login')));
  assert.ok(!logs.warn.join('\n').includes('probe.user'));
  assert.ok(!logs.warn.join('\n').includes('hunter2'));
});

test('login: malformed bodies are rejected with 400 and no token', async () => {
  for (const body of [{}, { username: 'ada' }, { password: PASSWORD }, { username: 42, password: PASSWORD }, { username: 'ada', password: { $ne: '' } }, { username: 'ada', password: 'x'.repeat(500) }]) {
    const r = await call('/api/auth/login', { method: 'POST', body });
    assert.equal(r.status, 400, JSON.stringify(body).slice(0, 60));
    assert.ok(!r.text.includes('token'));
  }
  const bad = await call('/api/auth/login', { method: 'POST', rawBody: '{not json' });
  assert.equal(bad.status, 400);
  assert.deepEqual(bad.json, { error: 'Invalid JSON body.' });
});

test('login: no JWT_SECRET configured fails closed with 503 and issues nothing', async () => {
  const s = await listen(makeApp({ env: { NODE_ENV: 'test' } }));
  try {
    const r = await call('/api/auth/login', { method: 'POST', body: { username: 'ada', password: PASSWORD }, origin: urlOf(s) });
    assert.equal(r.status, 503);
    assert.ok(!r.text.includes('token'));
  } finally { await close(s); }
});

// ── password hash non-disclosure ──────────────────────────────────────────────
test('password hashes and plaintext never appear in any response', async () => {
  const hash = store.byName.get('ada').passwordHash;
  const token = await validToken();
  const responses = [
    await login(),
    await login('ada', 'wrong password here'),
    await call('/api/auth/me', { token }),
    await call('/api/health', { token }),
    await call('/api/investigate', { method: 'POST', token, body: { question: 'Why is checkout failing?' } }),
  ];
  for (const r of responses) {
    assert.ok(!r.text.includes(hash), 'hash leaked');
    assert.ok(!/passwordHash|scrypt\$/.test(r.text), 'hash field leaked');
    assert.ok(!r.text.includes(PASSWORD), 'plaintext leaked');
  }
});

// ── /api/auth/me ──────────────────────────────────────────────────────────────
test('me: valid token returns the current user', async () => {
  const r = await call('/api/auth/me', { token: await validToken() });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, { user: { id: admin.id, username: 'ada', role: 'admin' } });
});

test('me: no, malformed, wrong-scheme, garbage, wrong-signature and expired tokens are all 401', async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = await validToken();
  const wrongSig = (await forge()).split('.').slice(0, 2).concat('A'.repeat(43)).join('.');
  const cases = {
    missing: {},
    emptyBearer: { headers: { Authorization: 'Bearer ' } },
    basicScheme: { headers: { Authorization: `Basic ${good}` } },
    noScheme: { headers: { Authorization: good } },
    twoParts: { headers: { Authorization: 'Bearer abc.def' } },
    garbage: { token: 'not.a.token' },
    tamperedSignature: { token: wrongSig },
    unsignedNone: { headers: { Authorization: `Bearer ${Buffer.from('{"alg":"none"}').toString('base64url')}.${Buffer.from(`{"sub":"${admin.id}"}`).toString('base64url')}.` } },
    extraTokens: { headers: { Authorization: `Bearer ${good} ${good}` } },
  };
  for (const [name, opts] of Object.entries(cases)) {
    const r = await call('/api/auth/me', opts);
    assert.equal(r.status, 401, name);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer', name);
    assert.equal(r.json.code, 'unauthorized', name);
  }
  const expired = await call('/api/auth/me', { token: await forge({ iat: now - 7200, exp: now - 3600 }) });
  assert.equal(expired.status, 401);
  assert.equal(expired.json.code, 'token_expired');
});

test('me: a valid token for a deleted or disabled user is rejected immediately', async () => {
  const ghost = await call('/api/auth/me', { token: await forge({ sub: 'no-such-user' }) });
  assert.equal(ghost.status, 401);

  const token = await validToken();
  store.byName.get('ada').disabled = true;
  try {
    assert.equal((await call('/api/auth/me', { token })).status, 401);
  } finally { store.byName.get('ada').disabled = false; }
  assert.equal((await call('/api/auth/me', { token })).status, 200);
});

// ── protected routes ──────────────────────────────────────────────────────────
const PROTECTED = [
  ['GET', '/api/graph'],
  ['GET', '/api/tools'],
  ['POST', '/api/tools/search_services', {}],
  ['POST', '/api/tools/get_offboarding_risk', { engineer: 'Avery Chen' }],
  ['POST', '/api/investigate', { question: 'Why is Checkout API failing?' }],
  ['GET', '/api/auth/me'],
  ['GET', '/api/auth/anything-else'],
  ['GET', '/api/does-not-exist'],
  ['POST', '/api/admin/users', {}],
];

test('every non-public /api route (including unknown ones) is 401 without a token and never reaches a handler', async () => {
  let touched = false;
  const spyTools = { TOOL_DEFINITIONS: DEFS, runTool: async () => { touched = true; return {}; }, getGraphSnapshot: async () => { touched = true; return SNAPSHOT; } };
  const s = await listen(makeApp({ tools: spyTools, investigateFn: async () => { touched = true; return INVESTIGATION; } }));
  try {
    for (const [method, path, body] of PROTECTED) {
      for (const token of [undefined, 'garbage.token.value']) {
        const r = await call(path, { method, body, token, origin: urlOf(s) });
        assert.equal(r.status, 401, `${method} ${path}`);
      }
    }
    assert.equal(touched, false, 'a protected handler or tool ran for an unauthenticated request');
  } finally { await close(s); }
});

test('authenticated users get unchanged response shapes', async () => {
  const token = await validToken();

  const graph = await call('/api/graph', { token });
  assert.equal(graph.status, 200);
  assert.deepEqual(graph.json, SNAPSHOT);

  const tools = await call('/api/tools', { token });
  assert.deepEqual(tools.json, { tools: DEFS });

  const tool = await call('/api/tools/search_services', { method: 'POST', token, body: { keyword: 'pay' } });
  assert.deepEqual(tool.json, { tool: 'search_services', data: { name: 'search_services', input: { keyword: 'pay' } } });

  const inv = await call('/api/investigate', { method: 'POST', token, body: { question: 'Why is Checkout API failing?' } });
  assert.deepEqual(inv.json, { question: 'Why is Checkout API failing?', ...INVESTIGATION });

  const short = await call('/api/investigate', { method: 'POST', token, body: { question: 'hi' } });
  assert.equal(short.status, 400);
  assert.match(short.json.error, /at least 5 characters/);

  const unknown = await call('/api/does-not-exist', { token });
  assert.equal(unknown.status, 404);
  assert.deepEqual(unknown.json, { error: 'Not found' });
});

// ── health ────────────────────────────────────────────────────────────────────
test('health: public view is minimal; authenticated view keeps the previous fields', async () => {
  const pub = await call('/api/health');
  assert.equal(pub.status, 200);
  assert.deepEqual(pub.json, { status: 'ok' });

  const badToken = await call('/api/health', { token: 'garbage.token.value' });
  assert.deepEqual(badToken.json, { status: 'ok' });

  const full = await call('/api/health', { token: await validToken() });
  assert.deepEqual(full.json, { status: 'ok', graph: 'synapse', nodes: 12, llmConfigured: true });
});

test('health: database failure returns 503 with no raw error text, but the detail is logged', async () => {
  logs.error.length = 0;
  const s = await listen(makeApp({ queryFn: async () => { throw new Error('connect ECONNREFUSED 10.1.2.3:6379 auth=hunter2'); } }));
  try {
    const token = (await call('/api/auth/login', { method: 'POST', body: { username: 'ada', password: PASSWORD }, origin: urlOf(s) })).json.token;
    for (const t of [undefined, token]) {
      const r = await call('/api/health', { token: t, origin: urlOf(s) });
      assert.equal(r.status, 503);
      assert.ok(!/ECONNREFUSED|10\.1\.2\.3|hunter2/.test(r.text));
    }
    assert.ok(logs.error.join('\n').includes('ECONNREFUSED'), 'detail should be in the server log');
  } finally { await close(s); }
});

// ── error sanitisation ────────────────────────────────────────────────────────
test('production 5xx responses are generic; full detail goes to the server log only', async () => {
  const boom = { TOOL_DEFINITIONS: DEFS, runTool: async () => { throw new Error('FalkorDB redis://user:s3cr3t@db.internal:6379 exploded'); }, getGraphSnapshot: async () => SNAPSHOT };
  const env = { JWT_SECRET: SECRET, NODE_ENV: 'production', GROQ_API_KEY: 'x' };
  logs.error.length = 0;
  const s = await listen(makeApp({ tools: boom, env }));
  try {
    const token = (await call('/api/auth/login', { method: 'POST', body: { username: 'ada', password: PASSWORD }, origin: urlOf(s) })).json.token;
    const r = await call('/api/tools/x', { method: 'POST', token, body: {}, origin: urlOf(s) });
    assert.equal(r.status, 500);
    assert.deepEqual(r.json, { error: 'Internal server error.' });
    assert.ok(logs.error.join('\n').includes('s3cr3t'), 'operators still get the detail in logs');
  } finally { await close(s); }
});

test('non-production keeps the existing "Server error: <message>" behaviour', async () => {
  const boom = { TOOL_DEFINITIONS: DEFS, runTool: async () => { throw new Error('kaput'); }, getGraphSnapshot: async () => SNAPSHOT };
  const s = await listen(makeApp({ tools: boom }));
  try {
    const token = (await call('/api/auth/login', { method: 'POST', body: { username: 'ada', password: PASSWORD }, origin: urlOf(s) })).json.token;
    const r = await call('/api/tools/x', { method: 'POST', token, body: {}, origin: urlOf(s) });
    assert.deepEqual(r.json, { error: 'Server error: kaput' });
  } finally { await close(s); }
});

test('user store outage during token verification returns 503, never authenticates', async () => {
  const broken = { ...store, findById: async () => { throw new Error('db down'); } };
  const s = await listen(makeApp({ userStore: broken }));
  try {
    const r = await call('/api/auth/me', { token: await forge(), origin: urlOf(s) });
    assert.equal(r.status, 503);
  } finally { await close(s); }
});

test('4xx errors raised on purpose keep their messages; other 4xx messages are not echoed', async () => {
  const token = await validToken();
  const big = await call('/api/investigate', { method: 'POST', token, body: { question: 'x'.repeat(20_000) } });
  assert.equal(big.status, 413);
  assert.deepEqual(big.json, { error: 'Request body too large.' });
  const tooLong = await call('/api/investigate', { method: 'POST', token, body: { question: 'x'.repeat(600) } });
  assert.match(tooLong.json.error, /too long/);
});
