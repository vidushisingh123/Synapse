import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, buildGraph, GraphUnavailableError } from '../src/agent.js';
import { ToolError } from '../src/graph/tools.js';
import { fakeRun, QUESTION } from './fixtures/nexuspay.js';

const saved = { key: process.env.GROQ_API_KEY, log: { ...console } };
beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  console.warn = console.error = () => {}; // expected fallbacks log noise
});
afterEach(() => {
  if (saved.key === undefined) delete process.env.GROQ_API_KEY;
  else process.env.GROQ_API_KEY = saved.key;
  Object.assign(console, saved.log);
});

const llmClient = (...steps) => {
  const queue = [...steps];
  return { chat: { completions: { create: async () => { const s = queue.shift(); if (s instanceof Error) throw s; return s; } } } };
};
const toolCall = (name, args = {}) => ({ model: 'fake', choices: [{ message: { content: null, tool_calls: [{ id: `c-${name}`, function: { name, arguments: JSON.stringify(args) } }] } }] });
const finalJson = (obj) => ({ model: 'fake', choices: [{ message: { content: JSON.stringify(obj) } }] });

test('graph-only: Checkout delay question returns a graph-backed, cited answer', async () => {
  const r = await investigate(QUESTION, { run: fakeRun });
  assert.equal(r.mode, 'graph-only');
  assert.match(r.warning, /GROQ_API_KEY is not set/);

  // Focus is Checkout API only ("API" in "Checkout API" must not pull in API Gateway as a target).
  assert.match(r.report.summary, /Focus: Checkout API \(matched by service name\)/);

  // Closest past incident is INC-130, and a past incident is never reported as "confirmed" for a current symptom.
  const rc = r.report.root_cause;
  assert.match(rc.assessment, /INC-130/);
  assert.equal(rc.confidence, 'likely');
  assert.notEqual(rc.confidence, 'confirmed');

  // Deployment correlation surfaces DEP-2050 (cited by INC-130), not just the newest deployment.
  assert.ok(r.report.hypotheses.some((h) => /DEP-2050/.test(h.text) && h.confidence === 'medium'));

  // Services to investigate: incident-linked + direct dependencies + direct callers.
  const step = r.report.next_steps.find((s) => s.startsWith('Investigate these services first'));
  for (const s of ['Payment Service', 'API Gateway', 'Inventory Service']) assert.ok(step.includes(s), `${s} missing`);

  // Honest about what the graph cannot know.
  assert.ok(r.report.gaps.some((g) => /No open incident is recorded/.test(g)));
  assert.ok(r.report.gaps.some((g) => /no live telemetry/.test(g)));

  // Every cited evidence id exists.
  const known = new Set(r.evidence.map((e) => e.id));
  const cited = [...r.report.facts.flatMap((f) => f.evidence), ...r.report.hypotheses.flatMap((h) => h.evidence), ...rc.evidence];
  assert.ok(cited.length && cited.every((id) => known.has(id)));
  assert.deepEqual(['search_services', 'get_service_dependencies', 'get_related_incidents'].filter((t) => !r.evidence.some((e) => e.tool === t)), []);
});

test('response includes graph entities and relationships from the evidence', async () => {
  const { graph } = await investigate(QUESTION, { run: fakeRun });
  const has = (s, t, x) => graph.edges.some((e) => e.source === s && e.type === t && e.target === x);
  assert.ok(has('Incident:INC-130', 'AFFECTS', 'Service:Checkout API'));
  assert.ok(has('Incident:INC-130', 'INVOLVES', 'Service:API Gateway'));
  assert.ok(has('Deployment:DEP-2050', 'DEPLOYED_TO', 'Service:API Gateway'));
  assert.ok(has('Service:Checkout API', 'DEPENDS_ON', 'Service:Payment Service'));
  assert.ok(has('Service:API Gateway', 'DEPENDS_ON', 'Service:Checkout API'));
  const ledger = graph.edges.find((e) => e.target === 'Service:Ledger Service' && e.source === 'Service:Checkout API');
  assert.equal(ledger.transitive, true);
  assert.equal(ledger.hops, 2);
  const ids = new Set(graph.nodes.map((n) => n.id));
  assert.ok(graph.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
});

test('an explicitly named, resolved incident is "confirmed"', async () => {
  const r = await investigate('What was the root cause of INC-130 on Checkout API?', { run: fakeRun });
  assert.equal(r.report.root_cause.confidence, 'confirmed');
  assert.match(r.report.root_cause.assessment, /^INC-130/);
});

test('question that matches nothing in the graph yields a limitation, not a guess', async () => {
  const r = await investigate('Why is the moon cheese slow on Tuesdays?', { run: fakeRun });
  assert.equal(r.mode, 'graph-only');
  assert.deepEqual(r.report.hypotheses, []);
  assert.equal(r.report.root_cause, undefined);
  assert.match(r.report.summary, /won't guess/);
});

test('offboarding question still routes to get_offboarding_risk', async () => {
  const r = await investigate('If Quinn Torres leaves, what is at risk?', { run: fakeRun });
  assert.ok(r.evidence.some((e) => e.tool === 'get_offboarding_risk'));
  assert.ok(r.report.facts.some((f) => /Ledger Service/.test(f.text)));
  assert.ok(r.graph.edges.some((e) => e.source === 'Engineer:Quinn Torres' && e.type === 'MAINTAINS'));
});

test('LLM failure falls back to graph-only with an accurate warning', async () => {
  process.env.GROQ_API_KEY = 'gsk_test_secret_value';
  const client = llmClient(Object.assign(new Error('boom gsk_test_secret_value'), { status: 500 }));
  const r = await investigate(QUESTION, { run: fakeRun, client });
  assert.equal(r.mode, 'graph-only');
  assert.match(r.warning, /Groq unavailable/);
  assert.ok(!r.warning.includes('gsk_test_secret_value'), 'secret must be redacted');
  assert.equal(r.model, undefined);
  assert.ok(r.report.facts.length > 0);
});

test('LLM rate limit is reported as such and falls back', async () => {
  process.env.GROQ_API_KEY = 'gsk_x';
  const err = Object.assign(new Error('429'), { status: 429 });
  const r = await investigate(QUESTION, { run: fakeRun, client: llmClient(err, err), sleep: async () => {} });
  assert.equal(r.mode, 'graph-only');
  assert.match(r.warning, /rate-limited/);
});

test('LLM that answers without querying the graph is not trusted', async () => {
  process.env.GROQ_API_KEY = 'gsk_x';
  const r = await investigate(QUESTION, { run: fakeRun, client: llmClient(finalJson({ summary: 'made up' })) });
  assert.equal(r.mode, 'graph-only');
  assert.match(r.warning, /did not query the graph/);
});

test('LLM success: evidence-checked, unsupported "confirmed" is downgraded, uncited facts demoted', async () => {
  process.env.GROQ_API_KEY = 'gsk_x';
  const client = llmClient(
    toolCall('search_services'),
    finalJson({
      summary: 'Checkout is slow.', affected_services: ['Checkout API'],
      root_cause: { assessment: 'Payment Service bug', confidence: 'confirmed', causal_chain: 'x', evidence: ['E1'], to_confirm: [] },
      facts: [{ text: 'cited', evidence: ['E1'] }, { text: 'invented', evidence: ['E99'] }],
      hypotheses: [], recommended_engineers: [], next_steps: [], gaps: [],
    }),
  );
  const r = await investigate(QUESTION, { run: fakeRun, client });
  assert.equal(r.mode, 'llm');
  assert.equal(r.report.root_cause.confidence, 'possible');
  assert.deepEqual(r.report.facts.map((f) => f.text), ['cited']);
  assert.ok(r.report.hypotheses.some((h) => /uncited by model/.test(h.text)));
  assert.ok(Array.isArray(r.graph.nodes));
});

test('database down: clean 503-style error, no stack or driver text exposed', async () => {
  const down = async () => { throw Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:6379'), { code: 'ECONNREFUSED' }); };
  await assert.rejects(investigate(QUESTION, { run: down }), (e) => {
    assert.ok(e instanceof GraphUnavailableError);
    assert.equal(e.status, 503);
    assert.equal(e.expose, true);
    assert.ok(!/ECONNREFUSED/.test(e.message));
    return true;
  });
});

test('database down while the LLM is enabled still ends in the clean error', async () => {
  process.env.GROQ_API_KEY = 'gsk_x';
  const down = async () => { throw Object.assign(new Error('Connection is closed.'), { code: 'ECONNRESET' }); };
  const client = llmClient(toolCall('search_services'), finalJson({ summary: 'no evidence' }));
  await assert.rejects(investigate(QUESTION, { run: down, client }), GraphUnavailableError);
});

test('deliberate errors (validation, RBAC) pass through untouched', async () => {
  const forbidden = Object.assign(new Error('Forbidden'), { name: 'ForbiddenError', status: 403, expose: true });
  await assert.rejects(investigate(QUESTION, { run: async () => { throw forbidden; } }), (e) => e === forbidden);
  const bad = new ToolError('nope');
  await assert.rejects(investigate(QUESTION, { run: async () => { throw bad; } }), (e) => e === bad);
});

test('buildGraph: a direct record overrides a path record; unknown tools add nothing', () => {
  const g = buildGraph([
    { id: 'E1', tool: 'get_offboarding_risk', data: { engineer: 'A', ownedServices: [], dependentServices: [{ dependent: 'X', ownedService: 'Y' }] } },
    { id: 'E2', tool: 'get_service_dependencies', data: { service: 'Y', dependsOn: [], dependents: [{ name: 'X', depth: 1 }] } },
    { id: 'E3', tool: 'search_services', data: { services: ['X'] } },
  ]);
  const e = g.edges.find((x) => x.source === 'Service:X' && x.target === 'Service:Y');
  assert.deepEqual(e.evidence, ['E1', 'E2']);
  assert.equal(e.transitive, undefined);
  assert.equal(g.nodes.filter((n) => n.label === 'Service').length, 2);
});
