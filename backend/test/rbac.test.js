import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import {
  PERMISSIONS, ROLES, ROLE_PERMISSIONS, TOOL_PERMISSIONS,
  hasPermission, permissionsForRole, isKnownRole, isKnownPermission,
  requirePermission, authorizeTool, createAuthorizedRun, ForbiddenError, UnknownToolError,
} from '../src/auth/rbac.js';
import { TOOL_DEFINITIONS } from '../src/graph/tools.js';
import { investigate } from '../src/agent.js';

const silent = { warn() {}, error() {}, info() {} };
const user = (role) => ({ id: `id-${role}`, username: role, role });

// Expected matrix, written out independently of the implementation.
const EXPECTED = {
  admin: ['graph:read', 'tools:invoke', 'investigate', 'offboarding:read', 'admin:users'],
  analyst: ['graph:read', 'tools:invoke', 'investigate', 'offboarding:read'],
  viewer: ['graph:read'],
};

// ── matrix ────────────────────────────────────────────────────────────────────
test('rbac: role/permission matrix matches the specification exactly', () => {
  assert.deepEqual([...ROLES].sort(), ['admin', 'analyst', 'viewer']);
  for (const role of ROLES) {
    assert.deepEqual([...permissionsForRole(role)].sort(), [...EXPECTED[role]].sort(), role);
    for (const perm of Object.values(PERMISSIONS)) {
      assert.equal(hasPermission(role, perm), EXPECTED[role].includes(perm), `${role} ${perm}`);
    }
  }
});

test('rbac: the matrix is immutable at runtime', () => {
  assert.throws(() => ROLE_PERMISSIONS.viewer.push('admin:users'), TypeError);
  assert.throws(() => { ROLE_PERMISSIONS.viewer = ['admin:users']; }, TypeError);
  assert.throws(() => { ROLE_PERMISSIONS.hacker = ['admin:users']; }, TypeError);
  assert.throws(() => TOOL_PERMISSIONS.get_offboarding_risk.pop(), TypeError);
  assert.equal(hasPermission('viewer', 'admin:users'), false);
});

test('rbac: unknown roles fail closed, including prototype keys and non-strings', () => {
  for (const role of ['superuser', 'ADMIN', 'Admin ', '', '__proto__', 'constructor', 'toString', 'hasOwnProperty', null, undefined, 42, {}, ['admin'], true]) {
    assert.equal(isKnownRole(role), false, String(role));
    assert.deepEqual(permissionsForRole(role), [], String(role));
    for (const perm of Object.values(PERMISSIONS)) assert.equal(hasPermission(role, perm), false, `${String(role)} ${perm}`);
  }
});

test('rbac: unknown permissions fail closed even for admin', () => {
  for (const perm of ['*', 'admin', 'admin:everything', 'GRAPH:READ', 'graph:read ', '', null, undefined, 7, {}, '__proto__', 'constructor']) {
    assert.equal(isKnownPermission(perm), false, String(perm));
    assert.equal(hasPermission('admin', perm), false, String(perm));
  }
});

test('rbac: a custom matrix cannot smuggle in unknown permissions', () => {
  const matrix = { ops: ['tools:invoke', 'made:up'] };
  assert.deepEqual(permissionsForRole('ops', matrix), ['tools:invoke']);
  assert.equal(hasPermission('ops', 'made:up', matrix), false);
  assert.equal(hasPermission('admin', 'graph:read', matrix), false, 'roles not in the supplied matrix are unknown');
});

// ── middleware ────────────────────────────────────────────────────────────────
function fakeRes() {
  return {
    code: null, body: null, headers: {},
    set(k, v) { this.headers[k] = v; return this; },
    status(c) { this.code = c; return this; },
    json(b) { this.body = b; return this; },
  };
}

test('requirePermission: refuses to be built with an unknown permission', () => {
  for (const bad of ['nope', undefined, null, '', 'ADMIN:USERS']) assert.throws(() => requirePermission(bad), /Unknown permission/);
});

test('requirePermission: 401 without a principal, 403 for missing permission or unknown role, next() otherwise', () => {
  const mw = requirePermission(PERMISSIONS.TOOLS_INVOKE, { logger: silent });
  let nexted = 0;
  const next = () => { nexted += 1; };

  const none = fakeRes();
  mw({ method: 'GET', path: '/x' }, none, next);
  assert.equal(none.code, 401);

  for (const role of ['viewer', 'superuser', undefined, '__proto__']) {
    const res = fakeRes();
    mw({ user: user(role), method: 'GET', path: '/x' }, res, next);
    assert.equal(res.code, 403, String(role));
    assert.equal(res.body.code, 'forbidden');
  }
  assert.equal(nexted, 0);

  for (const role of ['analyst', 'admin']) mw({ user: user(role), method: 'GET', path: '/x' }, fakeRes(), next);
  assert.equal(nexted, 2);
});

test('requirePermission: ignores role/permissions supplied in the request body, query or headers', () => {
  const mw = requirePermission(PERMISSIONS.ADMIN_USERS, { logger: silent });
  const res = fakeRes();
  let nexted = false;
  mw({
    user: user('viewer'), method: 'POST', path: '/x',
    body: { role: 'admin', permissions: ['admin:users'] }, query: { role: 'admin' }, headers: { 'x-role': 'admin' },
  }, res, () => { nexted = true; });
  assert.equal(nexted, false);
  assert.equal(res.code, 403);
});

test('admin:users gates admin-only functionality: admin passes; analyst, viewer and unknown roles get 403', async () => {
  // No user-management routes exist yet, so exercise the permission on a throwaway route.
  const users = { admin: user('admin'), analyst: user('analyst'), viewer: user('viewer'), ghost: user('ghost') };
  const app = express();
  app.use((req, _res, next) => { req.user = users[req.get('x-test-user')]; next(); });
  app.get('/admin-only', requirePermission(PERMISSIONS.ADMIN_USERS, { logger: silent }), (_req, res) => res.json({ ok: true }));
  const server = await new Promise((r) => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    const statusFor = async (who) => (await fetch(`${base}/admin-only`, { headers: who ? { 'x-test-user': who } : {} })).status;
    assert.equal(await statusFor('admin'), 200);
    assert.equal(await statusFor('analyst'), 403);
    assert.equal(await statusFor('viewer'), 403);
    assert.equal(await statusFor('ghost'), 403);
    assert.equal(await statusFor(undefined), 401);
  } finally { await new Promise((r) => server.close(r)); }
});

// ── tool authorization ────────────────────────────────────────────────────────
test('tool permissions: every real tool is mapped, nothing stale is mapped, and all permissions are known', () => {
  const real = TOOL_DEFINITIONS.map((t) => t.name).sort();
  assert.deepEqual(Object.keys(TOOL_PERMISSIONS).sort(), real, 'add new tools to TOOL_PERMISSIONS (unmapped tools cannot run)');
  for (const [tool, perms] of Object.entries(TOOL_PERMISSIONS)) {
    assert.ok(perms.length > 0, tool);
    for (const p of perms) assert.ok(isKnownPermission(p), `${tool}: ${p}`);
  }
  assert.ok(TOOL_PERMISSIONS.get_offboarding_risk.includes('offboarding:read'));
});

test('authorizeTool: viewers can run no tool; analysts and admins can run every mapped tool', () => {
  for (const tool of Object.keys(TOOL_PERMISSIONS)) {
    assert.throws(() => authorizeTool(user('viewer'), tool, { logger: silent }), ForbiddenError, tool);
    assert.doesNotThrow(() => authorizeTool(user('analyst'), tool, { logger: silent }), tool);
    assert.doesNotThrow(() => authorizeTool(user('admin'), tool, { logger: silent }), tool);
  }
});

test('authorizeTool: the offboarding tool needs offboarding:read in addition to tools:invoke', () => {
  const matrix = { ops: ['tools:invoke'], auditor: ['offboarding:read'] };
  assert.doesNotThrow(() => authorizeTool(user('ops'), 'search_services', { matrix, logger: silent }));
  assert.throws(() => authorizeTool(user('ops'), 'get_offboarding_risk', { matrix, logger: silent }), ForbiddenError);
  assert.throws(() => authorizeTool(user('auditor'), 'get_offboarding_risk', { matrix, logger: silent }), ForbiddenError);
});

test('authorizeTool: unknown or prototype-named tools fail closed for everyone, including admin', () => {
  for (const tool of ['nope', '', 'constructor', '__proto__', 'toString', 'hasOwnProperty', 'SEARCH_SERVICES', null, undefined, 5, {}]) {
    assert.throws(() => authorizeTool(user('admin'), tool, { logger: silent }), UnknownToolError, String(tool));
  }
});

test('authorizeTool: missing principal and unknown role are forbidden', () => {
  for (const u of [undefined, null, {}, user('ghost'), user('__proto__')]) {
    assert.throws(() => authorizeTool(u, 'search_services', { logger: silent }), ForbiddenError);
  }
});

test('createAuthorizedRun: denied calls never reach the underlying runner; allowed calls pass arguments through', async () => {
  const calls = [];
  const base = async (name, input) => { calls.push([name, input]); return { ok: true }; };

  const viewerRun = createAuthorizedRun(user('viewer'), base, { logger: silent });
  await assert.rejects(() => viewerRun('search_services', {}), ForbiddenError);
  await assert.rejects(() => viewerRun('does_not_exist', {}), UnknownToolError);
  assert.equal(calls.length, 0);

  const analystRun = createAuthorizedRun(user('analyst'), base, { logger: silent });
  assert.deepEqual(await analystRun('get_engineers', { service: 'Payment Service' }), { ok: true });
  assert.deepEqual(calls, [['get_engineers', { service: 'Payment Service' }]]);

  assert.throws(() => createAuthorizedRun(user('admin'), undefined), TypeError);
});

// ── the agent is held to the same rules ───────────────────────────────────────
function makeFakeRun(calls) {
  const data = {
    search_services: () => ({ services: ['Payment Service', 'Checkout API', 'Auth Service'] }),
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
  return async (name, input) => {
    calls.push(name);
    if (!(name in data)) throw new Error(`unexpected tool ${name}`);
    return data[name](input);
  };
}

const Q_OFFBOARD = 'If Avery Chen leaves next week, what knowledge is at risk and what handover tasks are most urgent?';
const Q_LATENCY = 'Why is Checkout API experiencing elevated latency?';

test('agent (graph-only): an analyst investigation works through the authorized runner, including offboarding', async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const calls = [];
    const run = createAuthorizedRun(user('analyst'), makeFakeRun(calls), { logger: silent });
    const latency = await investigate(Q_LATENCY, { run });
    assert.equal(latency.mode, 'graph-only');
    assert.ok(latency.evidence.length > 0);

    const off = await investigate(Q_OFFBOARD, { run });
    assert.equal(off.mode, 'graph-only');
    assert.ok(off.evidence.some((e) => e.tool === 'get_offboarding_risk'));
    assert.ok(calls.includes('get_offboarding_risk'));
  } finally { if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved; }
});

test('agent (graph-only): a role without offboarding:read is stopped at the tool, not after it', async () => {
  const saved = process.env.GROQ_API_KEY;
  delete process.env.GROQ_API_KEY;
  try {
    const calls = [];
    const matrix = { ops: ['graph:read', 'tools:invoke', 'investigate'] };
    const run = createAuthorizedRun(user('ops'), makeFakeRun(calls), { matrix, logger: silent });
    await assert.rejects(() => investigate(Q_OFFBOARD, { run }), ForbiddenError);
    assert.ok(!calls.includes('get_offboarding_risk'), 'the restricted tool must never execute');
    // Non-offboarding questions are unaffected for the same role.
    const ok = await investigate(Q_LATENCY, { run });
    assert.equal(ok.mode, 'graph-only');
  } finally { if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved; }
});

test('agent (LLM): a tool the model requests but the role may not use is refused and never executed', async () => {
  const saved = process.env.GROQ_API_KEY;
  process.env.GROQ_API_KEY = 'fake-key-for-test';
  try {
    const calls = [];
    const matrix = { ops: ['graph:read', 'tools:invoke', 'investigate'] };
    const run = createAuthorizedRun(user('ops'), makeFakeRun(calls), { matrix, logger: silent });

    const seen = [];
    let turn = 0;
    const client = {
      chat: {
        completions: {
          create: async (req) => {
            seen.push(JSON.parse(JSON.stringify(req.messages)));
            turn += 1;
            if (turn === 1) {
              return {
                model: 'fake',
                choices: [{ message: { content: null, tool_calls: [
                  { id: 'c1', function: { name: 'get_offboarding_risk', arguments: JSON.stringify({ engineer: 'Avery Chen' }) } },
                  { id: 'c2', function: { name: 'search_services', arguments: '{}' } },
                  { id: 'c3', function: { name: 'constructor', arguments: '{}' } },
                ] } }],
              };
            }
            return {
              model: 'fake',
              choices: [{ message: { content: JSON.stringify({ summary: 'done', affected_services: [], facts: [], hypotheses: [], recommended_engineers: [], next_steps: [], gaps: [] }) } }],
            };
          },
        },
      },
    };

    const res = await investigate('Tell me about Avery Chen', { run, client, sleep: async () => {} });
    assert.equal(res.mode, 'llm');
    assert.deepEqual(calls, ['search_services'], 'only the permitted tool executed');
    assert.deepEqual(res.evidence.map((e) => e.tool), ['search_services']);

    const toolMsgs = Object.fromEntries(seen[1].filter((m) => m.role === 'tool').map((m) => [m.tool_call_id, JSON.parse(m.content)]));
    assert.match(toolMsgs.c1.error, /Forbidden/);
    assert.ok(toolMsgs.c2.evidence_id);
    assert.match(toolMsgs.c3.error, /Unknown tool/);
  } finally { if (saved === undefined) delete process.env.GROQ_API_KEY; else process.env.GROQ_API_KEY = saved; }
});
