/**
 * investigation.test.js
 *
 * Tests for the investigation intelligence upgrade:
 *   - Root-cause analysis with and without incident evidence
 *   - Hypothesis vs. confirmed fact classification
 *   - Evidence ID traceability for root_cause
 *   - Missing optional graph data (no deployments, no incidents)
 *   - LLM unavailable / rate-limited → graph-only fallback with root_cause
 *   - Existing offboarding functionality unchanged
 *   - Evidence navigation: root_cause.evidence IDs exist in the evidence list
 *
 * No live API keys, no FalkorDB required — all graph calls are faked.
 */

import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, isRateLimit } from '../src/agent.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

beforeEach(() => {
  delete process.env.GROQ_API_KEY;
  mock.restoreAll();
});

/**
 * Standard fake run builder.
 * Values can be plain objects (returned as-is) or functions (called with input).
 */
function makeRun(overrides = {}) {
  const defaults = {
    search_services: { services: ['Checkout API', 'Payment Service', 'Auth Service', 'Inventory Service', 'Fraud Check Service'] },
    get_service_dependencies: (input) => ({
      service: input?.service ?? 'Checkout API',
      dependsOn: [
        { name: 'Payment Service', depth: 1 },
        { name: 'Inventory Service', depth: 1 },
        { name: 'Auth Service', depth: 1 },
      ],
      dependents: [{ name: 'Web App', depth: 1 }],
    }),
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
    get_repositories: () => ({
      service: 'Checkout API',
      repositories: [{ service: 'Checkout API', repository: 'checkout-api', url: 'https://github.com/nexuspay/checkout-api' }],
      servicesWithoutRepository: [],
    }),
    get_engineers: () => ({
      service: 'Checkout API',
      searchedServices: [],
      engineers: [
        { name: 'Sam Okafor', expertise: 'Checkout and API design', score: 6,
          maintains: [{ repository: 'checkout-api', service: 'Checkout API' }],
          investigated: [], authoredDeployments: [] },
        { name: 'Avery Chen', expertise: 'Payment systems', score: 4,
          maintains: [{ repository: 'payment-service', service: 'Payment Service' }],
          investigated: [{ incident: 'INC-130', service: 'Checkout API' }],
          authoredDeployments: [{ deployment: 'DEP-2041', service: 'Payment Service' }] },
      ],
    }),
    get_offboarding_risk: () => ({
      engineer: 'Sam Okafor', expertise: 'Checkout and API design',
      ownedServices: [{ service: 'Checkout API', repository: 'checkout-api', hasOtherMaintainer: false, otherMaintainers: [] }],
      soloMaintained: ['Checkout API'],
      unownedServices: ['Fraud Check Service'],
      uniquelyInvestigatedIncidents: [],
      recentDeployments: [],
      dependentServices: [{ dependent: 'Web App', ownedService: 'Checkout API' }],
    }),
  };
  const merged = { ...defaults, ...overrides };
  return async (name, input) => {
    if (name in merged) {
      const v = merged[name];
      return typeof v === 'function' ? v(input) : v;
    }
    throw new Error(`Unexpected tool: ${name}(${JSON.stringify(input)})`);
  };
}

/** An incident with a recorded root cause — the strongest graph signal. */
const INCIDENT_WITH_ROOT_CAUSE = {
  service: 'Checkout API', searchedServices: ['Checkout API', 'Payment Service'],
  incidents: [{
    id: 'INC-130',
    title: 'Checkout API elevated latency — p99 above 8 seconds',
    status: 'resolved',
    severity: 'high',
    rootCause: 'API Gateway connection pool reduction caused upstream queuing; Payment Service timeout cascaded to Checkout API',
    resolution: 'Reverted API Gateway pool size to 400; added per-route timeout overrides',
    links: [
      { relationship: 'AFFECTS', service: 'Checkout API' },
      { relationship: 'INVOLVES', service: 'Payment Service' },
    ],
  }],
};

/** An incident that is open with no root cause recorded. */
const INCIDENT_NO_ROOT_CAUSE = {
  service: 'Checkout API', searchedServices: ['Checkout API'],
  incidents: [{
    id: 'INC-137',
    title: 'Analytics dashboard stale data',
    status: 'open',
    severity: 'low',
    rootCause: null,
    resolution: null,
    links: [{ relationship: 'AFFECTS', service: 'Checkout API' }],
  }],
};

/** A recent deployment near the incident timeline. */
const DEPLOYMENT_NEAR_INCIDENT = {
  service: 'Checkout API', searchedServices: ['Checkout API', 'Payment Service'],
  deployments: [{
    id: 'DEP-2050',
    service: 'Payment Service',
    version: 'v3.1.0',
    deployedAt: '2026-10-15T18:45:00Z',
    summary: 'Reduced API Gateway HTTP connection pool size from 500 to 200 to limit downstream pressure',
  }],
};

const Q_CHECKOUT_LATENCY = 'Why is Checkout API experiencing elevated latency?';
const Q_REFUND_DELAYS = 'What do we know about refund processing incidents?';
const Q_OFFBOARDING = 'If Avery Chen leaves next week, what handover tasks are most urgent?';

// ---------------------------------------------------------------------------
// 1. Incident with relevant dependency evidence → root_cause is populated
// ---------------------------------------------------------------------------

test('incident with root cause: root_cause field is populated', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.report.root_cause, 'root_cause should be present for failure questions');
  assert.ok(typeof res.report.root_cause.assessment === 'string' && res.report.root_cause.assessment.length > 0,
    'assessment should be a non-empty string');
  assert.ok(['confirmed', 'likely', 'possible', 'unknown'].includes(res.report.root_cause.confidence),
    'confidence should be one of the four allowed values');
});

test('incident with resolved root cause: confidence is "confirmed"', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  assert.equal(res.report.root_cause.confidence, 'confirmed',
    'resolved incident with rootCause recorded should yield confirmed confidence');
});

test('incident with root cause: assessment contains the recorded root cause text', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  assert.match(res.report.root_cause.assessment,
    /connection pool|Payment Service|queuing/i,
    'assessment should include the recorded root cause text');
});

// ---------------------------------------------------------------------------
// 2. Incident with no root cause → confidence is not "confirmed"
// ---------------------------------------------------------------------------

test('open incident with no root cause: confidence is not "confirmed"', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_NO_ROOT_CAUSE,
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  // No root cause recorded, no deployment → should be "unknown"
  if (res.report.root_cause) {
    assert.notEqual(res.report.root_cause.confidence, 'confirmed',
      'should not be "confirmed" when incident has no rootCause field');
  }
});

test('no incidents and no deployments: root_cause is absent or confidence is "unknown"', async () => {
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  if (res.report.root_cause) {
    assert.equal(res.report.root_cause.confidence, 'unknown',
      'no evidence should yield unknown confidence');
    assert.deepEqual(res.report.root_cause.evidence, [],
      'no evidence IDs should be cited when there is no data');
  }
  // It is also valid to omit root_cause entirely when there is no data
});

// ---------------------------------------------------------------------------
// 3. Hypothesis must not be promoted to confirmed fact
// ---------------------------------------------------------------------------

test('deployment-only hypothesis: is a hypothesis, not a fact', async () => {
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  // The hypothesis text should contain the deployment ID
  const depHyp = res.report.hypotheses.find((h) => h.text.includes('DEP-2050'));
  assert.ok(depHyp, 'deployment correlation should appear as a hypothesis');
  assert.notEqual(depHyp.confidence, 'confirmed',
    'a deployment correlation without an incident root cause must not be "confirmed"');

  // The same claim must NOT appear as a fact
  const depFact = res.report.facts.find((f) => f.text.includes('DEP-2050') && /cause|trigger/i.test(f.text));
  assert.equal(depFact, undefined,
    'deployment correlation should not appear as a fact without a matching incident root cause');
});

test('root_cause with "possible" confidence is not described as confirmed in the text', async () => {
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  if (res.report.root_cause) {
    // Assessment text should not claim certainty when confidence is below "confirmed"
    if (res.report.root_cause.confidence !== 'confirmed') {
      assert.doesNotMatch(res.report.root_cause.assessment, /^confirmed|^the root cause is|^definitely/i,
        'uncertain root_cause should not use definitive language');
    }
  }
});

// ---------------------------------------------------------------------------
// 4. Evidence references correctly map to supporting records
// ---------------------------------------------------------------------------

test('root_cause evidence IDs all exist in the evidence list', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  if (res.report.root_cause?.evidence?.length) {
    const knownIds = new Set(res.evidence.map((e) => e.id));
    for (const id of res.report.root_cause.evidence) {
      assert.ok(knownIds.has(id), `root_cause evidence ID "${id}" not found in evidence list`);
    }
  }
});

test('all fact evidence IDs are traceable to the evidence list', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const fact of res.report.facts) {
    assert.ok(fact.evidence.length > 0, `fact must have at least one evidence ID: "${fact.text}"`);
    for (const id of fact.evidence) {
      assert.ok(knownIds.has(id), `fact evidence ID "${id}" not in evidence list`);
    }
  }
});

test('evidence list contains the tool name and input that produced each entry', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  for (const ev of res.evidence) {
    assert.ok(typeof ev.id === 'string' && ev.id.startsWith('E'), 'evidence ID should start with E');
    assert.ok(typeof ev.tool === 'string' && ev.tool.length > 0, 'evidence should have a tool name');
    assert.ok(ev.data !== undefined, 'evidence should have data');
  }
});

// ---------------------------------------------------------------------------
// 5. Missing optional graph data handled gracefully
// ---------------------------------------------------------------------------

test('no deployments: investigation completes without root_cause or with unknown confidence', async () => {
  const run = makeRun({
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  // Must still return a valid report shape
  assert.ok(typeof res.report.summary === 'string');
  assert.ok(Array.isArray(res.report.facts));
  assert.ok(Array.isArray(res.report.hypotheses));
  assert.ok(Array.isArray(res.report.gaps));
});

test('no engineers: investigation completes, recommended_engineers is empty', async () => {
  const run = makeRun({
    get_engineers: () => ({ service: 'Checkout API', searchedServices: [], engineers: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  assert.ok(Array.isArray(res.report.recommended_engineers));
  // May be empty — that's correct, do not invent engineers
  assert.ok(res.report.recommended_engineers.length === 0 || res.report.recommended_engineers.every((e) => e.name),
    'recommended_engineers entries must have names if present');
});

test('no repository for a service: appears in gaps not facts', async () => {
  const run = makeRun({
    get_repositories: () => ({
      service: 'Checkout API',
      repositories: [],
      servicesWithoutRepository: ['Checkout API', 'Payment Service'],
    }),
    get_related_incidents: () => ({ service: 'Checkout API', searchedServices: [], incidents: [] }),
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  const repoGap = res.report.gaps.find((g) => /repository|maintainer/i.test(g));
  assert.ok(repoGap, 'missing repository should surface as a gap');
});

// ---------------------------------------------------------------------------
// 6. LLM unavailable / rate-limited → graph-only fallback with root_cause
// ---------------------------------------------------------------------------

test('LLM unavailable (no API key): graph-only fallback still produces structured report', async () => {
  delete process.env.GROQ_API_KEY;
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  assert.equal(res.mode, 'graph-only');
  assert.ok(typeof res.report.summary === 'string' && res.report.summary.length > 0);
  assert.ok(Array.isArray(res.report.facts) && res.report.facts.length > 0, 'should have facts from graph data');
});

test('LLM rate-limited: fallback warning is set, mode is graph-only, root_cause is present', async () => {
  process.env.GROQ_API_KEY = 'gsk_test_key_for_rate_limit_test';
  const rateErr = Object.assign(new Error('429 rate limit'), {
    status: 429,
    headers: { 'retry-after': '2' },
    error: { code: 'rate_limit_exceeded' },
  });
  const fakeClient = {
    chat: { completions: { create: async () => { throw rateErr; } } },
  };
  const fakeSleep = async () => {};
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run, client: fakeClient, sleep: fakeSleep });

  assert.equal(res.mode, 'graph-only', 'should fall back to graph-only on rate limit');
  assert.ok(res.warning && /rate.limit|rate-limit/i.test(res.warning), 'warning should mention rate limiting');
  assert.ok(res.report.root_cause, 'graph-only fallback should still produce root_cause for failure questions');
});

// ---------------------------------------------------------------------------
// 7. Existing offboarding functionality unchanged
// ---------------------------------------------------------------------------

test('offboarding: root_cause is absent (not a failure question)', async () => {
  const run = makeRun({
    get_engineers: (input) => ({
      service: input?.service,
      searchedServices: [],
      engineers: [
        { name: 'Avery Chen', expertise: 'Payment systems', score: 6,
          maintains: [{ repository: 'payment-service', service: 'Payment Service' }],
          investigated: [], authoredDeployments: [] },
      ],
    }),
    get_offboarding_risk: () => ({
      engineer: 'Avery Chen', expertise: 'Payment systems',
      ownedServices: [{ service: 'Payment Service', repository: 'payment-service', hasOtherMaintainer: false, otherMaintainers: [] }],
      soloMaintained: ['Payment Service'],
      unownedServices: ['Fraud Check Service'],
      uniquelyInvestigatedIncidents: [{ id: 'INC-115', title: 'Fraud check latency spike', severity: 'medium', status: 'resolved' }],
      recentDeployments: [],
      dependentServices: [{ dependent: 'Checkout API', ownedService: 'Payment Service' }],
    }),
  });
  const res = await investigate(Q_OFFBOARDING, { run });

  assert.equal(res.mode, 'graph-only');
  assert.equal(res.report.root_cause, undefined, 'offboarding report should not have root_cause');
  // Offboarding-specific fields must still be present
  assert.ok(res.report.facts.some((f) => /solo|single.point/i.test(f.text)), 'solo maintainer fact must still appear');
  assert.ok(res.report.gaps.some((g) => /successor|backup/i.test(g)), 'no successor gap must still appear');
});

// ---------------------------------------------------------------------------
// 8. Evidence navigation and investigation-history compatibility
// ---------------------------------------------------------------------------

test('report shape has all fields needed by the frontend history', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  // Fields that history.js makeEntry and the frontend Report component depend on
  assert.ok(typeof res.mode === 'string');
  assert.ok(typeof res.report === 'object' && res.report !== null);
  assert.ok(typeof res.report.summary === 'string');
  assert.ok(Array.isArray(res.report.affected_services));
  assert.ok(Array.isArray(res.report.facts));
  assert.ok(Array.isArray(res.report.hypotheses));
  assert.ok(Array.isArray(res.report.recommended_engineers));
  assert.ok(Array.isArray(res.report.next_steps));
  assert.ok(Array.isArray(res.report.gaps));
  assert.ok(Array.isArray(res.evidence));

  // root_cause, when present, must have the expected shape
  if (res.report.root_cause) {
    const rc = res.report.root_cause;
    assert.ok(typeof rc.assessment === 'string');
    assert.ok(typeof rc.confidence === 'string');
    assert.ok(typeof rc.causal_chain === 'string');
    assert.ok(Array.isArray(rc.evidence));
    assert.ok(Array.isArray(rc.to_confirm));
  }
});

test('root_cause evidence IDs are cite-navigable: IDs start with E and match evidence entries', async () => {
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => DEPLOYMENT_NEAR_INCIDENT,
  });
  const res = await investigate(Q_CHECKOUT_LATENCY, { run });

  if (res.report.root_cause?.evidence?.length) {
    for (const id of res.report.root_cause.evidence) {
      // ID must start with E (e.g. E1, E2) — same format as Cites component expects
      assert.match(id, /^E\d+$/, `evidence ID "${id}" should be E followed by a number`);
      // Must exist in the evidence list so jumpToEvidence can find the element
      const found = res.evidence.find((e) => e.id === id);
      assert.ok(found, `evidence entry for "${id}" must exist for UI navigation`);
    }
  }
});

test('incident question (INC reference): investigation resolves facts and evidence IDs', async () => {
  const Q_INC = 'Tell me about INC-130';
  const run = makeRun({
    get_related_incidents: () => INCIDENT_WITH_ROOT_CAUSE,
    get_recent_deployments: () => ({ service: 'Checkout API', searchedServices: [], deployments: [] }),
  });
  const res = await investigate(Q_INC, { run });

  assert.ok(typeof res.report.summary === 'string');
  // At least one fact should mention INC-130
  const incFact = res.report.facts.find((f) => f.text.includes('INC-130'));
  assert.ok(incFact, 'INC-130 should appear as a fact');
  assert.ok(incFact.evidence.length > 0, 'INC-130 fact must cite evidence');
});
