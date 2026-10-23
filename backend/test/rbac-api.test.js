import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { SignJWT } from 'jose';
import { createApp } from '../src/app.js';
import { createAccount, createAdmin } from '../src/auth/admin.js';
import { hashPassword } from '../src/auth/password.js';
import { ROLE_PERMISSIONS, isKnownPermission } from '../src/auth/rbac.js';
import { TOKEN_ISSUER, TOKEN_AUDIENCE } from '../src/auth/config.js';
import { createMemoryUserStore } from './helpers/memory-user-store.js';

const SECRET = 'k3J9vQ2mZr8LwT5nB1xYc7HdP0sFgA4uE6oIeR2tWqVbN9yMzXjCh';
const PASSWORD = 'correct horse battery staple';
const key = new TextEncoder().encode(SECRET);
const ENV = { JWT_SECRET: SECRET, NODE_ENV: 'test' };

const logs = { warn: [] };
const logger = { info() {}, error() {}, warn: (...a) => logs.warn.push(a.join(' ')) };

// Spies prove that denied requests never reach tools, the graph, or the agent.
const calls = { tools: [], graph: 0, investigate: 0 };
const SNAPSHOT = { nodes: [{ id: 'Service:Checkout API', label: 'Service', name: 'Checkout API' }], edges: [] };
const DEFS = [{ name: 'search_services', description: 'x', input_schema: { type: 'object' } }];
const TOOL_DATA = {
  search_services: () => ({ services: ['Payment Service', 'Checkout API'] }),
  get_related_incidents: (i) => ({ service: i?.service, searchedServices: [], incidents: [] }),
  get_service_dependencies: (i) => ({ service: i?.service, dependsOn: [], dependents: [] }),
  get_recent_deployments: (i) => ({ service: i?.service, searchedServices: [], deployments: [] }),
  get_repositories: (i) => ({ service: i?.service, repositories: [], servicesWithoutRepository: [] }),
  get_engineers: (i) => ({
    service: i?.service, searchedServices: [],
    engineers: [{ name: 'Avery Chen', expertise: 'Payment systems', score: 6, maintains: [{ repository: 'payment-service', service: 'Payment Service' }], investigated: [], authoredDeployments: [] }],
  }),
  get_offboarding_risk: () => ({
    engineer: 'Avery Chen', expertise: 'Payment systems',
    ownedServices: [{ service: 'Payment Service', repository: 'payment-service', hasOtherMaintainer: false, otherMaintainers: [] }],
    soloMaintained: ['Payment Service'], unownedServices: [], uniquelyInvestigatedIncidents: [], recentDeployments: [], dependentServices: [],
  }),
};
const runTool = async (name, input) => {
  calls.tools.push(name);
  if (!Object.hasOwn(TOOL_DATA, name)) throw new Error(`unexpected tool ${name}`);
  return TOOL_DATA[name](input);
};
const tools = {
  TOOL_DEFINITIONS: DEFS,
  runTool,
  getGraphSnapshot: async () => { calls.graph += 1; return SNAPSHOT; },
};
const resetCalls = () => { calls.tools.length = 0; calls.graph = 0; calls.investigate = 0; };

const store = createMemoryUserStore();
const OPS_MATRIX = { ...ROLE_PERMISSIONS, ops: ['graph:read', 'tools:invoke', 'investigate'] }; // no offboarding:read

let server;
let ops; // server with the extra "ops" role
let base;
let opsBase;
const ids = {};

const listen = (app) => new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
const urlOf = (s) => `http://127.0.0.1:${s.address().port}`;
const close = (s) => new Promise((r) => s.close(r));
const makeApp = (extra = {}) => createApp({ userStore: store, tools, env: ENV, logger, queryFn: async () => [{ nodes: 1 }], ...extra });

before(async () => {
  const root = await createAdmin({ username: 'root', password: PASSWORD, store }); // the Milestone 1 path
  const analyst = await createAccount({ username: 'ana', password: PASSWORD, role: 'analyst', store });
  const viewer = await createAccount({ username: 'vic', password: PASSWORD, role: 'viewer', store });
  const operator = await store.createUser({ username: 'ops.user', passwordHash: await hashPassword(PASSWORD), role: 'ops' });
  const ghost = await store.createUser({ username: 'ghost', passwordHash: await hashPassword(PASSWORD), role: 'superuser' });
  Object.assign(ids, { root: root.id, ana: analyst.id, vic: viewer.id, ops: operator.id, ghost: ghost.id });
  server = await listen(makeApp());
  ops = await listen(makeApp({ rolePermissions: OPS_MATRIX }));
  base = urlOf(server);
  opsBase = urlOf(ops);
});
after(async () => { await close(server); await close(ops); });

async function call(path, { method = 'GET', token, headers = {}, body, origin = base } = {}) {
  const res = await fetch(origin + path, {
    method,
    headers: { ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}), ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, text, headers: res.headers };
}
async function loginAs(username, origin = base) {
  const r = await call('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD }, origin });
  assert.equal(r.status, 200, `login ${username}`);
  return r.json.token;
}
const forge = (claims = {}, sub) => {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT(claims).setProtectedHeader({ alg: 'HS256' }).setSubject(sub).setIssuer(TOKEN_ISSUER).setAudience(TOKEN_AUDIENCE)
    .setIssuedAt(now).setExpirationTime(now + 600).sign(key);
};

const Q = 'Why is Checkout API experiencing elevated latency?';
const Q_OFF = 'If Avery Chen leaves next week, what knowledge is at risk and what handover tasks are most urgent?';

// operation name -> request
const OPS = {
  'GET /api/auth/me': ['/api/auth/me', 'GET'],
  'GET /api/graph': ['/api/graph', 'GET'],
  'GET /api/tools': ['/api/tools', 'GET'],
  'POST /api/tools/search_services': ['/api/tools/search_services', 'POST', {}],
  'POST /api/tools/get_offboarding_risk': ['/api/tools/get_offboarding_risk', 'POST', { engineer: 'Avery Chen' }],
  'POST /api/investigate': ['/api/investigate', 'POST', { question: Q }],
  'POST /api/investigate (offboarding)': ['/api/investigate', 'POST', { question: Q_OFF }],
};
const ALLOW = {
  admin: Object.keys(OPS),
  analyst: Object.keys(OPS),
  viewer: ['GET /api/auth/me', 'GET /api/graph'],
};

async function withNoGroq(fn) {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY; // keep the agent on the graph-only path; no real LLM, no real key
  try { return await fn(); } finally { if (saved !== undefined) process.env.GROQ_API_KEY = saved; }
}

// ── role × operation matrix ───────────────────────────────────────────────────
for (const [role, username] of [['admin', 'root'], ['analyst', 'ana'], ['viewer', 'vic']]) {
  test(`${role}: allowed operations succeed, everything else is 403 and runs nothing`, async () => {
    await withNoGroq(async () => {
      const token = await loginAs(username);
      for (const [name, [path, method, body]] of Object.entries(OPS)) {
        resetCalls();
        const r = await call(path, { method, body, token });
        if (ALLOW[role].includes(name)) {
          assert.equal(r.status, 200, `${role}: ${name}`);
        } else {
          assert.equal(r.status, 403, `${role}: ${name}`);
          assert.equal(r.json.code, 'forbidden');
          assert.deepEqual(calls.tools, [], `${role}: ${name} must not execute any tool`);
          assert.equal(calls.graph, 0);
        }
      }
    });
  });
}

test('admin account created through the Milestone 1 path keeps working with no migration', async () => {
  const r = await call('/api/auth/me', { token: await loginAs('root') });
  assert.equal(r.json.user.role, 'admin');
  assert.ok(r.json.permissions.includes('admin:users'));
});

test('viewer: can read the graph with the unchanged response shape', async () => {
  const r = await call('/api/graph', { token: await loginAs('vic') });
  assert.equal(r.status, 200);
  assert.deepEqual(r.json, SNAPSHOT);
});

test('analyst: investigations run end to end (real agent, graph-only) including offboarding', async () => {
  await withNoGroq(async () => {
    const token = await loginAs('ana');
    resetCalls();
    const inv = await call('/api/investigate', { method: 'POST', token, body: { question: Q } });
    assert.equal(inv.status, 200);
    assert.equal(inv.json.question, Q);
    assert.equal(inv.json.mode, 'graph-only');
    assert.ok(Array.isArray(inv.json.evidence) && inv.json.evidence.length > 0);
    assert.ok(typeof inv.json.report.summary === 'string');

    const off = await call('/api/investigate', { method: 'POST', token, body: { question: Q_OFF } });
    assert.equal(off.status, 200);
    assert.ok(off.json.evidence.some((e) => e.tool === 'get_offboarding_risk'));
  });
});

test('analyst: direct tool endpoint works; unknown and prototype-named tools are 404 and never run', async () => {
  const token = await loginAs('ana');
  resetCalls();
  const ok = await call('/api/tools/get_engineers', { method: 'POST', token, body: { service: 'Payment Service' } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.tool, 'get_engineers');
  assert.deepEqual(calls.tools, ['get_engineers']);

  resetCalls();
  for (const name of ['nope', 'constructor', '__proto__', 'toString', 'hasOwnProperty']) {
    const r = await call(`/api/tools/${name}`, { method: 'POST', token, body: {} });
    assert.equal(r.status, 404, name);
    assert.match(r.json.error, /Unknown tool/);
  }
  assert.deepEqual(calls.tools, []);
});

test('viewer: tool endpoints are 403 for every tool name, so tool existence is not revealed', async () => {
  const token = await loginAs('vic');
  resetCalls();
  for (const name of [...Object.keys(TOOL_DATA), 'nope', 'constructor']) {
    const r = await call(`/api/tools/${name}`, { method: 'POST', token, body: { service: 'x', engineer: 'y' } });
    assert.equal(r.status, 403, name);
  }
  assert.deepEqual(calls.tools, []);
});

test('viewer: permission is checked before the request body, so even invalid investigations are 403', async () => {
  const token = await loginAs('vic');
  for (const body of [{}, { question: '' }, { question: 'x'.repeat(600) }]) {
    assert.equal((await call('/api/investigate', { method: 'POST', token, body })).status, 403);
  }
});

// ── the principal comes only from the verified token + user lookup ────────────
test('a viewer cannot escalate via request body, query string, headers, or extra token claims', async () => {
  const token = await loginAs('vic');
  const attempts = [
    call('/api/investigate', { method: 'POST', token, body: { question: Q, role: 'admin', permissions: ['investigate'] } }),
    call('/api/tools/search_services?role=admin&permissions=tools:invoke', { method: 'POST', token, body: { role: 'admin' } }),
    call('/api/tools/search_services', { method: 'POST', token, body: {}, headers: { 'X-Role': 'admin', 'X-Permissions': 'tools:invoke', 'X-User-Role': 'admin' } }),
    // Correctly signed token for the viewer that CLAIMS admin: claims are ignored, the stored role wins.
    call('/api/tools', { token: await forge({ role: 'admin', permissions: ['tools:invoke', 'admin:users'], scope: '*' }, ids.vic) }),
  ];
  for (const r of await Promise.all(attempts)) assert.equal(r.status, 403);
});

test('a role change takes effect on the very next request with the same token', async () => {
  const token = await loginAs('ana');
  assert.equal((await call('/api/tools', { token })).status, 200);
  const rec = store.byName.get('ana');
  rec.role = 'viewer';
  try {
    assert.equal((await call('/api/tools', { token })).status, 403);
    assert.equal((await call('/api/graph', { token })).status, 200);
  } finally { rec.role = 'analyst'; }
  assert.equal((await call('/api/tools', { token })).status, 200);
});

test('a user with an unknown stored role is authenticated but fails closed everywhere', async () => {
  const token = await loginAs('ghost');
  for (const [name, [path, method, body]] of Object.entries(OPS)) {
    if (name === 'GET /api/auth/me') continue;
    const r = await call(path, { method, body, token });
    assert.equal(r.status, 403, name);
  }
  const me = await call('/api/auth/me', { token });
  assert.equal(me.status, 200);
  assert.deepEqual(me.json.permissions, []);
});

// ── authentication still comes first ──────────────────────────────────────────
test('missing, malformed, tampered and expired tokens are 401 (not 403) on every permissioned route', async () => {
  const now = Math.floor(Date.now() / 1000);
  const good = await loginAs('root');
  const tampered = good.split('.').slice(0, 2).concat('A'.repeat(43)).join('.');
  const expired = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ids.root).setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE).setIssuedAt(now - 7200).setExpirationTime(now - 3600).sign(key);
  const wrongKey = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ids.root).setIssuer(TOKEN_ISSUER)
    .setAudience(TOKEN_AUDIENCE).setIssuedAt(now).setExpirationTime(now + 600).sign(new TextEncoder().encode('q'.repeat(40) + 'Zx9Kd2'));
  const variants = { missing: undefined, malformed: 'not-a-jwt', tampered, expired, wrongKey };
  for (const [vname, token] of Object.entries(variants)) {
    for (const [name, [path, method, body]] of Object.entries(OPS)) {
      resetCalls();
      const r = await call(path, { method, body, token });
      assert.equal(r.status, 401, `${vname}: ${name}`);
    }
    assert.deepEqual(calls.tools, []);
    assert.equal(calls.graph, 0);
  }
});

test('a valid token for an unknown subject grants nothing', async () => {
  const r = await call('/api/graph', { token: await forge({}, 'no-such-user') });
  assert.equal(r.status, 401);
});

// ── tool-level enforcement inside the agent, over HTTP ────────────────────────
test('a role with investigate but not offboarding:read gets 403 and the offboarding tool never runs', async () => {
  await withNoGroq(async () => {
    const token = await loginAs('ops.user', opsBase);
    resetCalls();
    const off = await call('/api/investigate', { method: 'POST', token, body: { question: Q_OFF }, origin: opsBase });
    assert.equal(off.status, 403);
    assert.equal(off.json.code, 'forbidden');
    assert.ok(!calls.tools.includes('get_offboarding_risk'));

    const direct = await call('/api/tools/get_offboarding_risk', { method: 'POST', token, body: { engineer: 'Avery Chen' }, origin: opsBase });
    assert.equal(direct.status, 403);
    assert.ok(!calls.tools.includes('get_offboarding_risk'));

    const fine = await call('/api/investigate', { method: 'POST', token, body: { question: Q }, origin: opsBase });
    assert.equal(fine.status, 200);
  });
});

test('the default server does not recognise the extra "ops" role (custom matrices are code-only)', async () => {
  const token = await loginAs('ops.user');
  assert.equal((await call('/api/graph', { token })).status, 403);
});

// ── route inventory: nothing can be added without declaring a permission ──────
test('every /api route is either on the public allowlist, auth-only (/me), or declares a known permission', () => {
  const app = makeApp();
  const PUBLIC = new Set(['GET /api/health', 'POST /api/auth/login']);
  const AUTH_ONLY = new Set(['GET /api/auth/me']);
  const found = [];
  const walk = (stack, prefix) => {
    for (const layer of stack) {
      if (layer.route) {
        for (const m of Object.keys(layer.route.methods)) {
          found.push({ id: `${m.toUpperCase()} ${prefix}${layer.route.path}`, handlers: layer.route.stack.map((l) => l.handle) });
        }
      } else if (layer.handle?.stack) {
        assert.equal(prefix, '', 'unexpected nested router');
        assert.ok(String(layer.matchers?.[0]?.('/api/auth')?.path ?? '/api/auth').startsWith('/api/auth'), 'only the /api/auth router may be mounted');
        walk(layer.handle.stack, '/api/auth');
      }
    }
  };
  walk(app.router.stack, '');
  assert.ok(found.length >= 7, `expected to discover the routes, found ${found.length}`);
  for (const r of found) {
    if (PUBLIC.has(r.id) || AUTH_ONLY.has(r.id)) continue;
    const perm = r.handlers.map((h) => h.requiredPermission).find(Boolean);
    assert.ok(isKnownPermission(perm), `${r.id} has no permission middleware`);
  }
  // The public list must not silently grow.
  assert.deepEqual(found.filter((r) => PUBLIC.has(r.id)).map((r) => r.id).sort(), [...PUBLIC].sort());
});

test('login and health stay public; unauthenticated health is minimal', async () => {
  assert.deepEqual((await call('/api/health')).json, { status: 'ok' });
  assert.equal((await call('/api/auth/login', { method: 'POST', body: { username: 'vic', password: PASSWORD } })).status, 200);
});

test('denials are logged server-side with the user id and permission, without tokens', async () => {
  logs.warn.length = 0;
  const token = await loginAs('vic');
  await call('/api/tools', { token });
  const line = logs.warn.find((l) => l.includes('[rbac] denied'));
  assert.ok(line, 'denial should be logged');
  assert.ok(line.includes('tools:invoke') && line.includes(ids.vic));
  assert.ok(!line.includes(token));
});
