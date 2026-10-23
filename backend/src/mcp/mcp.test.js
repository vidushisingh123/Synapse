// MCP server tests: registration, input validation, Streamable HTTP transport and access control.
// A real MCP client (official SDK) talks to the real Express app over HTTP; real auth middleware, JWT,
// password hashing and RBAC are used. Only the graph tool runner, the agent and the user store are fakes.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createApp } from '../app.js';
import { createMcpServer, inputShapeFrom } from './server.js';
import { issueToken } from '../auth/tokens.js';
import { TOKEN_ISSUER, TOKEN_AUDIENCE } from '../auth/config.js';
import { PERMISSIONS, ROLE_PERMISSIONS, TOOL_PERMISSIONS, createAuthorizedRun } from '../auth/rbac.js';

const SECRET = randomBytes(32).toString('hex');
const env = { JWT_SECRET: SECRET, NODE_ENV: 'test' };
const silent = { warn() {}, error() {}, info() {}, log() {} };

// Same names and input shapes as graph/tools.js TOOL_DEFINITIONS.
const serviceInput = { type: 'object', properties: { service: { type: 'string', description: 'Service name' } }, required: ['service'] };
const DEFS = [
  { name: 'search_services', description: 'List services.', input_schema: { type: 'object', properties: { keyword: { type: 'string' } } } },
  { name: 'get_service_dependencies', description: 'Dependencies.', input_schema: serviceInput },
  { name: 'get_related_incidents', description: 'Incidents.', input_schema: serviceInput },
  { name: 'get_recent_deployments', description: 'Deployments.', input_schema: serviceInput },
  { name: 'get_repositories', description: 'Repositories.', input_schema: serviceInput },
  { name: 'get_engineers', description: 'Engineers.', input_schema: serviceInput },
  { name: 'get_offboarding_risk', description: 'Offboarding.', input_schema: { type: 'object', properties: { engineer: { type: 'string' } }, required: ['engineer'] } },
];
const ALL_NAMES = DEFS.map((d) => d.name).sort();

class ToolError extends Error { constructor(m) { super(m); this.name = 'ToolError'; this.status = 400; } }

// Role with tools:invoke but WITHOUT offboarding:read.
const matrix = { ...ROLE_PERMISSIONS, toolsonly: [PERMISSIONS.GRAPH_READ, PERMISSIONS.TOOLS_INVOKE] };

let users, ran, servers = [];
const userStore = {
  async findById(id) { return users.find((u) => u.id === id) ?? null; },
  async findByUsername(n) { return users.find((u) => u.username === n) ?? null; },
};
const fakeRunTool = async (name, input) => {
  ran.push([name, input]);
  if (input?.service === 'Nope') throw new ToolError('No service matches "Nope". Known services: Checkout API');
  if (input?.service === 'Boom') throw new Error('db password=hunter2 at 10.0.0.5');
  return { tool: name, input };
};
const tools = { TOOL_DEFINITIONS: DEFS, runTool: fakeRunTool, getGraphSnapshot: async () => ({ nodes: [], edges: [] }) };

async function startApp(extraEnv = {}) {
  const app = createApp({
    userStore, tools, queryFn: async () => [{ nodes: 1 }], rolePermissions: matrix, logger: silent,
    investigateFn: async () => ({ report: { summary: 's' } }), env: { ...env, ...extraEnv },
  });
  const server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  servers.push(server);
  return `http://127.0.0.1:${server.address().port}`;
}

let base;
before(async () => {
  users = ['admin', 'analyst', 'viewer', 'toolsonly'].map((role) => ({ id: randomUUID(), username: `${role}1`, role, passwordHash: 'x', disabled: false }));
  ran = [];
  base = await startApp();
});
after(() => Promise.all(servers.map((s) => new Promise((r) => s.close(r)))));

const tokenFor = async (name) => (await issueToken(users.find((u) => u.username === name), { env })).token;
const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 't', version: '1' } } };
const raw = (method, { token, body, headers, url = base } = {}) => fetch(`${url}/mcp`, {
  method,
  headers: { 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream', ...(token ? { Authorization: `Bearer ${token}` } : {}), ...headers },
  body: body === undefined ? undefined : JSON.stringify(body),
});
async function connect(username, url = base) {
  const client = new Client({ name: 'test-client', version: '1.0.0' });
  const transport = new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
    requestInit: { headers: { Authorization: `Bearer ${await tokenFor(username)}` } },
  });
  await client.connect(transport);
  return client;
}
async function tryCall(client, name, args) {
  try {
    const r = await client.callTool({ name, arguments: args });
    return { error: Boolean(r.isError), text: r.content?.[0]?.text ?? '', result: r };
  } catch (e) {
    return { error: true, text: String(e.message), result: null };
  }
}

// ---------- registration ----------

test('registers every graph tool for a role that may use them, with schema and read-only hints', async () => {
  const client = await connect('analyst1');
  const { tools: listed } = await client.listTools();
  assert.deepEqual(listed.map((t) => t.name).sort(), ALL_NAMES);
  const dep = listed.find((t) => t.name === 'get_service_dependencies');
  assert.deepEqual(dep.inputSchema.required, ['service']);
  assert.equal(dep.inputSchema.properties.service.type, 'string');
  assert.equal(listed.find((t) => t.name === 'search_services').inputSchema.required, undefined);
  for (const t of listed) assert.equal(t.annotations.readOnlyHint, true);
  await client.close();
});

test('tools/list only contains tools the role is permitted to use (fail closed)', async () => {
  const client = await connect('toolsonly1');
  const names = (await client.listTools()).tools.map((t) => t.name);
  assert.equal(names.includes('get_offboarding_risk'), false);
  assert.equal(names.length, DEFS.length - 1);
  await client.close();
});

test('registration set equals the permission-mapped definitions (no drift, unmapped tools never exposed)', async () => {
  const extra = [...DEFS, { name: 'unmapped_tool', description: 'x', input_schema: { type: 'object', properties: {} } }];
  const server = createMcpServer({ user: { id: 'u', role: 'admin' }, definitions: extra, run: async () => ({}), logger: silent });
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const names = (await client.listTools()).tools.map((t) => t.name).sort();
  assert.deepEqual(names, Object.keys(TOOL_PERMISSIONS).sort());
  assert.equal(names.includes('unmapped_tool'), false);
  await client.close();
});

test('unsupported input schema types fail loudly at registration', () => {
  assert.throws(() => inputShapeFrom({ type: 'object', properties: { n: { type: 'number' } } }), /Unsupported MCP input type/);
});

// ---------- tool calls and input validation ----------

test('valid calls reach the shared runner and return structured content', async () => {
  ran.length = 0;
  const client = await connect('analyst1');
  const r = await tryCall(client, 'get_service_dependencies', { service: '  Checkout API  ' });
  assert.equal(r.error, false);
  assert.deepEqual(r.result.structuredContent, { tool: 'get_service_dependencies', input: { service: 'Checkout API' } }); // trimmed
  assert.deepEqual(JSON.parse(r.result.content[0].text), r.result.structuredContent);
  const s = await tryCall(client, 'search_services', {});
  assert.equal(s.error, false);
  assert.deepEqual(ran.map((x) => x[0]), ['get_service_dependencies', 'search_services']);
  await client.close();
});

test('invalid inputs are rejected before the runner is called', async () => {
  ran.length = 0;
  const client = await connect('analyst1');
  const bad = [
    ['get_engineers', {}], ['get_engineers', { service: '' }], ['get_engineers', { service: '   ' }],
    ['get_engineers', { service: 42 }], ['get_engineers', { service: { $ne: 1 } }], ['get_engineers', { service: 'x'.repeat(201) }],
    ['get_offboarding_risk', {}], ['search_services', { keyword: ['a'] }],
  ];
  for (const [name, args] of bad) {
    const r = await tryCall(client, name, args);
    assert.equal(r.error, true, `${name} ${JSON.stringify(args).slice(0, 40)} should be rejected`);
  }
  assert.deepEqual(ran, []);
  await client.close();
});

test('unknown input keys are not forwarded to the runner', async () => {
  ran.length = 0;
  const client = await connect('analyst1');
  const r = await tryCall(client, 'get_engineers', { service: 'Checkout API', cypher: 'MATCH (n) DETACH DELETE n' });
  assert.equal(r.error, false);
  assert.deepEqual(ran[0][1], { service: 'Checkout API' });
  await client.close();
});

test('unknown tools are rejected', async () => {
  ran.length = 0;
  const client = await connect('admin1');
  assert.equal((await tryCall(client, 'delete_everything', {})).error, true);
  assert.deepEqual(ran, []);
  await client.close();
});

test('deliberate ToolErrors surface their message; unexpected errors are generic and never leak internals', async () => {
  const client = await connect('analyst1');
  const known = await tryCall(client, 'get_repositories', { service: 'Nope' });
  assert.equal(known.error, true);
  assert.match(known.text, /No service matches "Nope"/);
  const boom = await tryCall(client, 'get_repositories', { service: 'Boom' });
  assert.equal(boom.error, true);
  assert.equal(/hunter2|10\.0\.0\.5/.test(boom.text), false);
  await client.close();
});

test('a run denied at call time (role changed mid-flight) is reported as forbidden and runs nothing', async () => {
  let executed = 0;
  const user = { id: 'u1', role: 'viewer' }; // viewer holds no tool permissions
  const run = createAuthorizedRun(user, async () => { executed += 1; return {}; }, { matrix, logger: silent });
  const server = createMcpServer({ user: { id: 'u1', role: 'admin' }, definitions: DEFS, run, matrix, logger: silent }); // registered as admin, runner is viewer's
  const [a, b] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'c', version: '1' });
  await Promise.all([server.connect(a), client.connect(b)]);
  const r = await tryCall(client, 'search_services', {});
  assert.equal(r.error, true);
  assert.match(r.text, /Forbidden/);
  assert.equal(executed, 0);
  await client.close();
});

// ---------- transport ----------

test('Streamable HTTP: stateless JSON responses, no session id, POST only', async () => {
  const token = await tokenFor('analyst1');
  const init = await raw('POST', { token, body: INIT });
  assert.equal(init.status, 200);
  assert.match(init.headers.get('content-type'), /application\/json/);
  assert.equal(init.headers.get('mcp-session-id'), null);
  assert.equal(init.headers.get('cache-control'), 'no-store');
  const body = await init.json();
  assert.equal(body.result.serverInfo.name, 'synapse-graph');
  for (const method of ['GET', 'DELETE']) {
    const r = await raw(method, { token });
    assert.equal(r.status, 405);
    assert.equal(r.headers.get('allow'), 'POST');
  }
});

test('MCP_ENABLED=false removes the endpoint entirely', async () => {
  const off = await startApp({ MCP_ENABLED: 'false' });
  const r = await raw('POST', { token: await tokenFor('admin1'), body: INIT, url: off });
  assert.equal(r.status, 404);
});

// ---------- access control ----------

test('unauthenticated requests are refused and run nothing', async () => {
  ran.length = 0;
  for (const method of ['POST', 'GET', 'DELETE']) {
    const r = await raw(method, { body: method === 'POST' ? INIT : undefined });
    assert.equal(r.status, 401, method);
    assert.equal(r.headers.get('www-authenticate'), 'Bearer');
  }
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_services', arguments: {} } };
  assert.equal((await raw('POST', { body: call })).status, 401);
  assert.deepEqual(ran, []);
  await assert.rejects(new Client({ name: 'c', version: '1' }).connect(new StreamableHTTPClientTransport(new URL(`${base}/mcp`))));
});

test('forged, wrong-audience, expired, disabled and deleted-user tokens are refused', async () => {
  const u = users.find((x) => x.username === 'analyst1');
  const enc = (s) => new TextEncoder().encode(s);
  const sign = (secret, aud = TOKEN_AUDIENCE) => new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(u.id)
    .setIssuer(TOKEN_ISSUER).setAudience(aud).setIssuedAt().setExpirationTime('1h').sign(enc(secret));
  const expired = (await issueToken(u, { env, nowMs: Date.now() - 2 * 3600 * 1000 })).token;
  for (const token of ['garbage', await sign(randomBytes(32).toString('hex')), await sign(SECRET, 'other'), expired]) {
    assert.equal((await raw('POST', { token, body: INIT })).status, 401);
  }
  const temp = { id: randomUUID(), username: 'temp1', role: 'analyst', passwordHash: 'x', disabled: false };
  users.push(temp);
  const { token } = await issueToken(temp, { env });
  assert.equal((await raw('POST', { token, body: INIT })).status, 200);
  temp.disabled = true;
  assert.equal((await raw('POST', { token, body: INIT })).status, 401);
  temp.disabled = false;
  users.splice(users.indexOf(temp), 1);
  assert.equal((await raw('POST', { token, body: INIT })).status, 401);
});

test('a viewer (no tools:invoke) cannot use MCP at all', async () => {
  ran.length = 0;
  const token = await tokenFor('viewer1');
  assert.equal((await raw('POST', { token, body: INIT })).status, 403);
  const call = { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'search_services', arguments: {} } };
  assert.equal((await raw('POST', { token, body: call })).status, 403);
  assert.deepEqual(ran, []);
});

test('offboarding data requires offboarding:read over MCP too', async () => {
  ran.length = 0;
  const lite = await connect('toolsonly1');
  const denied = await tryCall(lite, 'get_offboarding_risk', { engineer: 'Avery Chen' });
  assert.equal(denied.error, true);
  assert.equal(ran.some(([n]) => n === 'get_offboarding_risk'), false);
  await lite.close();
  const analyst = await connect('analyst1');
  assert.equal((await tryCall(analyst, 'get_offboarding_risk', { engineer: 'Avery Chen' })).error, false);
  await analyst.close();
});

test('browser requests from an unexpected Origin are refused; the configured origin is accepted', async () => {
  const token = await tokenFor('analyst1');
  assert.equal((await raw('POST', { token, body: INIT, headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await raw('POST', { token, body: INIT, headers: { Origin: 'http://localhost:5173' } })).status, 200);
});

test('existing /api routes are unchanged by the MCP endpoint', async () => {
  const token = await tokenFor('analyst1');
  const get = (p, t) => fetch(base + p, { headers: t ? { Authorization: `Bearer ${t}` } : {} });
  assert.equal((await get('/api/graph')).status, 401);
  assert.equal((await get('/api/graph', token)).status, 200);
  const inv = await fetch(`${base}/api/investigate`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` }, body: JSON.stringify({ question: 'Why is checkout failing?' }) });
  assert.equal(inv.status, 200);
  assert.equal((await get('/mcp-not-a-route', token)).status, 404);
});

test('MCP is stateless: the token is re-verified on EVERY request, so an expired token fails tools/list with token_expired', async () => {
  const u = users.find((x) => x.username === 'analyst1');
  const list = { jsonrpc: '2.0', id: 3, method: 'tools/list', params: {} };

  // A freshly issued token works for initialize and tools/list alike.
  const fresh = await tokenFor('analyst1');
  assert.equal((await raw('POST', { token: fresh, body: INIT })).status, 200);
  const ok = await raw('POST', { token: fresh, body: list });
  assert.equal(ok.status, 200);
  assert.equal((await ok.json()).result.tools.length, DEFS.length);

  // The same user's token past its lifetime (beyond the 5 s clock tolerance) is refused with a machine-readable code.
  const expired = (await issueToken(u, { env, nowMs: Date.now() - 2 * 3600 * 1000 })).token;
  const denied = await raw('POST', { token: expired, body: list });
  assert.equal(denied.status, 401);
  assert.equal(denied.headers.get('www-authenticate'), 'Bearer');
  assert.equal((await denied.json()).code, 'token_expired');
});
