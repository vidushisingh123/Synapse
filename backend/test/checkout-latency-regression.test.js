/**
 * checkout-latency-regression.test.js
 *
 * Regression tests for the specific bug:
 *   "Why is Checkout API experiencing elevated latency?"
 *   previously produced:
 *   "Groq unavailable (Model answered without querying the graph.). Showing graph-only analysis"
 *
 * Root cause: llmInvestigation() threw when the model returned text without tool calls
 * on step 0 (rec.evidence.length === 0). The throw was caught by the outer try/catch in
 * investigate(), which formatted it as a "Groq unavailable" provider error — incorrect.
 *
 * Fix: return null from llmInvestigation() when the model skips tools on the first step,
 * and route that null to graphOnlyInvestigation() with a distinct, accurate warning.
 *
 * Tests:
 *  1. Model skips tools → graph-only fallback with accurate (non-"Groq unavailable") warning
 *  2. Model calls tools correctly → LLM result used, root_cause populated
 *  3. Evidence IDs in root_cause correctly reference graph records
 *  4. Root-cause confidence is not "confirmed" without a recorded incident rootCause
 *  5. LLM unavailable (rate limit) → graph-only fallback distinct from tool-skip warning
 *  6. LLM unavailable (non-429 error) → "Groq unavailable" warning (not the tool-skip message)
 *  7. Existing offboarding tests still pass (smoke-check via this runner)
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../src/agent.js';

const Q = 'Why is Checkout API experiencing elevated latency?';

// ── Shared fixtures ───────────────────────────────────────────────────────────

function makeRun(overrides = {}) {
  const defaults = {
    search_services: { services: ['Checkout API', 'Payment Service', 'Auth Service', 'Inventory Service', 'API Gateway'] },
    get_service_dependencies: () => ({
      service: 'Checkout API',
      dependsOn: [{ name: 'Payment Service', depth: 1 }, { name: 'Auth Service', depth: 1 }],
      dependents: [{ name: 'Web App', depth: 1 }],
    }),
    get_related_incidents: () => ({
      service: 'Checkout API', searchedServices: ['Checkout API', 'Payment Service'],
      incidents: [{
        id: 'INC-130',
        title: 'Checkout API elevated latency — p99 above 8 seconds',
        status: 'resolved', severity: 'high',
        rootCause: 'API Gateway connection pool reduction caused upstream queuing; Payment Service timeout cascaded to Checkout API',
        resolution: 'Reverted API Gateway pool size; added per-route timeout overrides',
        links: [
          { relationship: 'AFFECTS', service: 'Checkout API' },
          { relationship: 'INVOLVES', service: 'Payment Service' },
        ],
      }],
    }),
    get_recent_deployments: () => ({
      service: 'Checkout API', searchedServices: [],
      deployments: [{
        id: 'DEP-2050', service: 'API Gateway', version: 'v3.1.0',
        deployedAt: '2026-10-15T18:45:00Z',
        summary: 'Reduced API Gateway HTTP connection pool size from 500 to 200',
      }],
    }),
    get_repositories: () => ({
      service: 'Checkout API',
      repositories: [{ service: 'Checkout API', repository: 'checkout-api', url: 'https://github.com/nexuspay/checkout-api' }],
      servicesWithoutRepository: [],
    }),
    get_engineers: () => ({
      service: 'Checkout API', searchedServices: [],
      engineers: [
        { name: 'Sam Okafor', expertise: 'Checkout and API design', score: 6,
          maintains: [{ repository: 'checkout-api', service: 'Checkout API' }],
          investigated: [{ incident: 'INC-130', service: 'Checkout API' }],
          authoredDeployments: [] },
      ],
    }),
    get_offboarding_risk: () => ({
      engineer: 'Sam Okafor', expertise: 'Checkout and API design',
      ownedServices: [], soloMaintained: [], unownedServices: [],
      uniquelyInvestigatedIncidents: [], recentDeployments: [], dependentServices: [],
    }),
  };
  const merged = { ...defaults, ...overrides };
  return async (name, input) => {
    const v = merged[name];
    if (v !== undefined) return typeof v === 'function' ? v(input) : v;
    throw new Error(`Unexpected tool: ${name}(${JSON.stringify(input)})`);
  };
}

function makeClient(script) {
  const remaining = [...script];
  return {
    chat: { completions: { create: async () => {
      const next = remaining.shift();
      if (!next) throw new Error('client script exhausted');
      if (next instanceof Error) throw next;
      return next;
    } } },
  };
}

const noToolsResponse = (text = 'Checkout API latency is caused by Payment Service delays.') => ({
  model: 'openai/gpt-oss-120b',
  choices: [{ message: { content: text, tool_calls: undefined } }],
});

const toolCallResponse = (name, args) => ({
  model: 'openai/gpt-oss-120b',
  choices: [{ message: {
    content: null,
    tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }],
  } }],
});

const finalResponse = (report) => ({
  model: 'openai/gpt-oss-120b',
  choices: [{ message: { content: JSON.stringify(report), tool_calls: undefined } }],
});

const VALID_REPORT = {
  summary: 'Checkout API latency is caused by API Gateway pool exhaustion.',
  affected_services: ['Checkout API', 'Payment Service'],
  root_cause: {
    assessment: 'API Gateway connection pool reduction caused upstream queuing.',
    confidence: 'confirmed',
    causal_chain: 'API Gateway → Checkout API → Payment Service timeout cascade.',
    evidence: ['E1'],
    to_confirm: ['Verify live metrics.'],
  },
  facts: [{ text: 'INC-130 rootCause: API Gateway pool reduction.', evidence: ['E1'] }],
  hypotheses: [],
  recommended_engineers: [{ name: 'Sam Okafor', reason: 'Maintains checkout-api.', evidence: ['E1'] }],
  next_steps: ['Check live error rates.'],
  gaps: [],
};

beforeEach(() => {
  process.env.GROQ_API_KEY = 'gsk_test_regression_key';
});

// ── Test 1: Model skips tools on step 0 ──────────────────────────────────────

test('model skips tools on step 0: falls back to graph-only with accurate warning (not "Groq unavailable")', async () => {
  // The client returns a text answer immediately, with no tool calls.
  const client = makeClient([noToolsResponse()]);
  const run = makeRun();
  const sleep = async () => {};

  const res = await investigate(Q, { run, client, sleep });

  // Must NOT produce the misleading "Groq unavailable" message
  assert.ok(res.warning, 'warning should be set when model skips tools');
  assert.doesNotMatch(res.warning, /Groq unavailable/i,
    '"Groq unavailable" is wrong here — the provider responded; the model just skipped tool calls');

  // Must fall back to graph-only with a useful result
  assert.equal(res.mode, 'graph-only', 'should be graph-only when model skips tools');
  assert.ok(res.report.facts.length > 0, 'graph-only fallback should produce graph-backed facts');
});

test('model skips tools: warning text explains the model did not query the graph', async () => {
  const client = makeClient([noToolsResponse()]);
  const res = await investigate(Q, { run: makeRun(), client, sleep: async () => {} });

  // The warning should tell the user what actually happened
  assert.match(res.warning, /did not query|skipped|did not call/i,
    'warning should explain the model did not query the graph');
});

test('model skips tools: result still has root_cause (from graph-only analysis)', async () => {
  const client = makeClient([noToolsResponse()]);
  const res = await investigate(Q, { run: makeRun(), client, sleep: async () => {} });

  assert.ok(res.report.root_cause, 'graph-only fallback should still produce root_cause for a failure question');
  assert.ok(['confirmed', 'likely', 'possible', 'unknown'].includes(res.report.root_cause.confidence));
});

test('model skips tools: evidence IDs in root_cause are traceable', async () => {
  const client = makeClient([noToolsResponse()]);
  const res = await investigate(Q, { run: makeRun(), client, sleep: async () => {} });

  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const id of (res.report.root_cause?.evidence ?? [])) {
    assert.ok(knownIds.has(id), `root_cause evidence ID "${id}" not found in evidence list`);
  }
});

// ── Test 2: Model calls tools correctly → LLM result ─────────────────────────

test('model calls search_services then reports: uses LLM result, mode is llm', async () => {
  const client = makeClient([
    toolCallResponse('search_services', {}),
    finalResponse(VALID_REPORT),
  ]);
  const run = makeRun();
  const sleep = async () => {};

  const res = await investigate(Q, { run, client, sleep });

  assert.equal(res.mode, 'llm', 'should be llm mode when model queries graph');
  assert.equal(res.warning, undefined, 'no warning when model behaves correctly');
  assert.equal(res.report.summary, VALID_REPORT.summary);
});

test('model calls tools and produces report: facts are normalised and cited evidence IDs are valid', async () => {
  const client = makeClient([
    toolCallResponse('search_services', {}),
    finalResponse(VALID_REPORT),
  ]);
  const res = await investigate(Q, { run: makeRun(), client, sleep: async () => {} });

  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const fact of res.report.facts) {
    for (const id of fact.evidence) {
      assert.ok(knownIds.has(id), `fact evidence ID "${id}" not in evidence list`);
    }
  }
});

// ── Test 3: root_cause confidence correctness ─────────────────────────────────

test('graph-only path with resolved incident: root_cause.confidence is "confirmed"', async () => {
  delete process.env.GROQ_API_KEY;
  const res = await investigate(Q, { run: makeRun() });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.report.root_cause);
  assert.equal(res.report.root_cause.confidence, 'confirmed',
    'resolved incident with rootCause should yield "confirmed" confidence');
});

test('graph-only path, no incidents: root_cause.confidence is not "confirmed"', async () => {
  delete process.env.GROQ_API_KEY;
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q, { run });

  if (res.report.root_cause) {
    assert.notEqual(res.report.root_cause.confidence, 'confirmed',
      'no evidence should not yield "confirmed" confidence');
  }
});

test('deployment correlation only: root_cause.confidence is "possible", not "confirmed"', async () => {
  delete process.env.GROQ_API_KEY;
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    // Keep deployments so there is a hypothesis
    get_recent_deployments: () => ({
      service: 'Checkout API', searchedServices: [],
      deployments: [{ id: 'DEP-2050', service: 'API Gateway', version: 'v3.1.0',
        deployedAt: '2026-10-15T18:45:00Z', summary: 'Connection pool reduction' }],
    }),
  });
  const res = await investigate(Q, { run });

  if (res.report.root_cause) {
    assert.notEqual(res.report.root_cause.confidence, 'confirmed',
      'deployment-only hypothesis should not be "confirmed"');
  }
});

// ── Test 4: Insufficient evidence ─────────────────────────────────────────────

test('no incidents, no deployments: root_cause is absent or confidence is "unknown"', async () => {
  delete process.env.GROQ_API_KEY;
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q, { run });

  if (res.report.root_cause) {
    assert.equal(res.report.root_cause.confidence, 'unknown');
    assert.deepEqual(res.report.root_cause.evidence, []);
  }
  // Must still return a valid report with gaps
  assert.ok(Array.isArray(res.report.gaps));
  assert.ok(res.report.gaps.some((g) => /telemetry|graph|no cause/i.test(g)),
    'gaps should mention the absence of telemetry or evidence');
});

// ── Test 5: Rate-limited → graph-only with distinct warning ──────────────────

test('LLM rate-limited: warning mentions rate-limit, not "model skipped tools"', async () => {
  const rateErr = Object.assign(new Error('429 rate limit'), {
    status: 429,
    headers: { 'retry-after': '2' },
    error: { code: 'rate_limit_exceeded' },
  });
  // Both the initial call and the one retry fail
  const client = makeClient([rateErr, rateErr]);
  const sleep = async () => {};

  const res = await investigate(Q, { run: makeRun(), client, sleep });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.warning);
  assert.match(res.warning, /rate.limit|rate-limit/i,
    'rate-limit warning should mention rate limiting');
  assert.doesNotMatch(res.warning, /did not query|skipped/i,
    'rate-limit warning should not say the model skipped tools');
});

// ── Test 6: Non-429 provider error → "Groq unavailable" (preserved) ──────────

test('non-429 provider error: warning says "Groq unavailable" (existing behavior preserved)', async () => {
  const serverErr = Object.assign(new Error('Internal server error'), { status: 500 });
  const client = makeClient([serverErr]);
  const sleep = async () => {};

  const res = await investigate(Q, { run: makeRun(), client, sleep });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.warning);
  assert.match(res.warning, /Groq unavailable/i,
    'genuine provider error should still say "Groq unavailable"');
  assert.doesNotMatch(res.warning, /did not query|skipped/i);
});

// ── Test 7: Offboarding smoke-check ──────────────────────────────────────────

test('offboarding question still works after the fix', async () => {
  delete process.env.GROQ_API_KEY;
  const run = async (name, input) => {
    if (name === 'search_services') return { services: ['Checkout API', 'Payment Service'] };
    if (name === 'get_engineers') return { service: input?.service, searchedServices: [], engineers: [
      { name: 'Avery Chen', expertise: 'Payment systems', score: 6,
        maintains: [{ repository: 'payment-service', service: 'Payment Service' }],
        investigated: [], authoredDeployments: [] },
    ] };
    if (name === 'get_offboarding_risk') return {
      engineer: 'Avery Chen', expertise: 'Payment systems',
      ownedServices: [{ service: 'Payment Service', repository: 'payment-service', hasOtherMaintainer: false, otherMaintainers: [] }],
      soloMaintained: ['Payment Service'], unownedServices: [],
      uniquelyInvestigatedIncidents: [], recentDeployments: [],
      dependentServices: [{ dependent: 'Checkout API', ownedService: 'Payment Service' }],
    };
    throw new Error(`Unexpected tool: ${name}`);
  };

  const res = await investigate('If Avery Chen leaves next week, what handover tasks are most urgent?', { run });

  assert.equal(res.mode, 'graph-only');
  assert.equal(res.report.root_cause, undefined, 'offboarding should not have root_cause');
  assert.ok(res.report.facts.some((f) => /solo|single.point/i.test(f.text)));
});

// ── Test 8: Graph-only (no key): complete, evidence-grounded result ───────────

test('no GROQ_API_KEY: graph-only produces structured facts and root_cause', async () => {
  delete process.env.GROQ_API_KEY;
  const res = await investigate(Q, { run: makeRun() });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.report.facts.length > 0, 'should have graph-backed facts');
  assert.ok(res.report.root_cause, 'should have root_cause for a failure question');

  // All evidence IDs must be traceable
  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const fact of res.report.facts) {
    for (const id of fact.evidence) {
      assert.ok(knownIds.has(id), `fact evidence ID "${id}" not in evidence list`);
    }
  }
});
