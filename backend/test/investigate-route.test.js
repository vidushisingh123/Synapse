// HTTP-level checks for POST /api/investigate: JWT, RBAC, input validation and error mapping.
// Needs the real dependencies (express, cors, jose) and src/auth/validation.js, so run it in the repo
// after `npm install`. No FalkorDB or Groq is needed: tools and users are injected.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { issueToken } from '../src/auth/tokens.js';
import { fakeRun, QUESTION } from './fixtures/nexuspay.js';

const env = { JWT_SECRET: 'k3J9xQ2mZp7LwR4tY8vB1nC6dF0hG5sA-test-only', NODE_ENV: 'test' };
const users = {
  analyst: { id: 'u-analyst', username: 'ann', role: 'analyst', disabled: false },
  viewer: { id: 'u-viewer', username: 'vic', role: 'viewer', disabled: false },
};
const userStore = { findById: async (id) => Object.values(users).find((u) => u.id === id) ?? null, findByUsername: async () => null };
const quiet = { warn() {}, error() {}, log() {} };

let server, base, runTool = fakeRun;
before(async () => {
  delete process.env.GROQ_API_KEY; // exercise the graph-only path
  const app = createApp({
    userStore, env, logger: quiet,
    tools: { TOOL_DEFINITIONS: [], runTool: (n, i) => runTool(n, i), getGraphSnapshot: async () => ({ nodes: [], edges: [] }) },
  });
  await new Promise((resolve) => { server = app.listen(0, resolve); });
  base = `http://127.0.0.1:${server.address().port}`;
  console.warn = () => {};
});
after(() => server?.close());

const post = async (body, who) => {
  const headers = { 'content-type': 'application/json' };
  if (who) headers.authorization = `Bearer ${(await issueToken(users[who], { env })).token}`;
  const res = await fetch(`${base}/api/investigate`, { method: 'POST', headers, body: JSON.stringify(body) });
  return { status: res.status, json: await res.json() };
};

test('no token -> 401', async () => assert.equal((await post({ question: QUESTION })).status, 401));
test('viewer lacks the investigate permission -> 403', async () => assert.equal((await post({ question: QUESTION }, 'viewer')).status, 403));

test('invalid question input -> 400 with a clear message', async () => {
  for (const question of [undefined, 12345, ['a', 'b', 'c'], { x: 1 }, '   hi ', 'x'.repeat(501)]) {
    const r = await post({ question }, 'analyst');
    assert.equal(r.status, 400, JSON.stringify(question)?.slice(0, 30));
    assert.ok(typeof r.json.error === 'string' && r.json.error.length > 5);
  }
});

test('analyst gets answer, evidence and graph through the existing contract', async () => {
  const r = await post({ question: QUESTION }, 'analyst');
  assert.equal(r.status, 200);
  assert.equal(r.json.question, QUESTION);
  assert.equal(r.json.mode, 'graph-only');
  assert.ok(r.json.report.summary && r.json.report.root_cause);
  assert.ok(r.json.evidence.length > 0);
  assert.ok(r.json.graph.edges.some((e) => e.source === 'Incident:INC-130' && e.target === 'Service:Checkout API'));
});

test('graph database down -> 503 graph_unavailable (no driver details)', async () => {
  runTool = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }); };
  try {
    const r = await post({ question: QUESTION }, 'analyst');
    assert.equal(r.status, 503);
    assert.equal(r.json.code, 'graph_unavailable');
    assert.ok(!/ECONNREFUSED|6379/.test(JSON.stringify(r.json)));
  } finally { runTool = fakeRun; }
});
