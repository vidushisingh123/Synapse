/**
 * offboarding.test.js
 *
 * Focused unit tests for the Knowledge Continuity & Offboarding feature.
 * No network, no FalkorDB, no Groq — all graph calls are faked via the
 * injected `run` function accepted by investigate(question, { run }).
 *
 * Covers:
 *  - Sole maintainer: single-point-of-failure surfaces as a verified fact
 *  - Multiple maintainers: covered service does NOT appear as a gap
 *  - Missing ownership: unowned service surfaces as a gap, not a fact
 *  - Unknown engineer: returns informative limitation, not an error
 *  - Evidence traceability: every fact in the report has a valid evidence ID
 *  - Graph-only fallback: offboarding intent routes correctly without Groq
 */

import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { investigate } from '../src/agent.js';

// Ensure no real Groq key is present so all tests use the graph-only path
beforeEach(() => {
  delete process.env.GROQ_API_KEY;
});

// ── Fake run helpers ─────────────────────────────────────────────────────────

/**
 * Build a fake run() function from a map of tool → response.
 * Throws a recognisable error for any unexpected tool call.
 */
function fakeRun(overrides = {}) {
  const defaults = {
    search_services: { services: ['Payment Service', 'Checkout API', 'Auth Service', 'Fraud Check Service', 'Inventory Service'] },
    get_related_incidents: { service: 'Payment Service', searchedServices: [], incidents: [] },
    get_service_dependencies: { service: 'Payment Service', dependsOn: [], dependents: [{ name: 'Checkout API', depth: 1 }] },
    get_recent_deployments: { service: 'Payment Service', searchedServices: [], deployments: [] },
    get_repositories: { service: 'Payment Service', repositories: [{ service: 'Payment Service', repository: 'payment-service', url: 'https://github.com/example/payment-service' }], servicesWithoutRepository: [] },
    // get_engineers is called by the discovery scan inside graphOnlyInvestigation.
    // Return enough data so Avery Chen and Riley Moss are discoverable.
    get_engineers: (input) => ({
      service: input?.service ?? 'Payment Service',
      searchedServices: [],
      engineers: [
        { name: 'Avery Chen', expertise: 'Payment systems', score: 6, maintains: [{ repository: 'payment-service', service: 'Payment Service' }], investigated: [], authoredDeployments: [] },
        { name: 'Riley Moss', expertise: 'Auth and security', score: 4, maintains: [{ repository: 'auth-service', service: 'Auth Service' }], investigated: [], authoredDeployments: [] },
      ],
    }),
  };
  const merged = { ...defaults, ...overrides };
  return async (name, input) => {
    if (name in merged) {
      const val = merged[name];
      return typeof val === 'function' ? val(input) : val;
    }
    throw new Error(`Unexpected tool call: ${name}(${JSON.stringify(input)})`);
  };
}

/** Standard get_offboarding_risk response for Avery Chen (sole maintainer). */
function averySolo() {
  return {
    engineer: 'Avery Chen',
    expertise: 'Payment systems',
    ownedServices: [{ service: 'Payment Service', repository: 'payment-service', hasOtherMaintainer: false, otherMaintainers: [] }],
    soloMaintained: ['Payment Service'],
    unownedServices: ['Fraud Check Service'],
    uniquelyInvestigatedIncidents: [{ id: 'INC-115', title: 'Fraud check latency spike', severity: 'medium', status: 'resolved' }],
    recentDeployments: [{ id: 'DEP-2041', service: 'Payment Service', version: 'v2.4.1', deployedAt: '2026-10-14T09:12:00Z', summary: 'Lowered payment gateway client timeout' }],
    dependentServices: [{ dependent: 'Checkout API', ownedService: 'Payment Service' }],
  };
}

/** get_offboarding_risk response for Riley Moss (covered — has a backup maintainer). */
function rileyWithBackup() {
  return {
    engineer: 'Riley Moss',
    expertise: 'Auth and security',
    ownedServices: [{ service: 'Auth Service', repository: 'auth-service', hasOtherMaintainer: true, otherMaintainers: ['Sam Okafor'] }],
    soloMaintained: [],          // covered: another maintainer is on record
    unownedServices: ['Fraud Check Service'],
    uniquelyInvestigatedIncidents: [],
    recentDeployments: [],
    dependentServices: [],
  };
}

const Q_AVERY = 'If Avery Chen leaves next week, what knowledge is at risk and what handover tasks are most urgent?';
const Q_RILEY = 'If Riley Moss leaves, what is at risk?';
const Q_UNKNOWN = 'If Alex Unknown leaves, what is at risk?';

// ── Tests ────────────────────────────────────────────────────────────────────

test('sole maintainer: Payment Service surfaces as a verified fact with evidence ID', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  assert.equal(res.mode, 'graph-only');
  assert.ok(res.report.facts.length > 0, 'should have at least one fact');

  // Every fact must have at least one valid evidence ID
  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const fact of res.report.facts) {
    assert.ok(fact.evidence.length > 0, `fact missing evidence: "${fact.text}"`);
    for (const id of fact.evidence) {
      assert.ok(knownIds.has(id), `evidence ID ${id} not in evidence list`);
    }
  }

  // The solo-maintained service must be mentioned as a fact
  const soloFact = res.report.facts.find((f) => f.text.includes('Payment Service') && f.text.includes('single-point'));
  assert.ok(soloFact, 'solo-maintained fact not found');
});

test('sole maintainer: blast-radius service (Checkout API) appears in affected_services', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  assert.ok(res.report.affected_services.includes('Checkout API'), 'Checkout API should be in affected_services');
});

test('sole maintainer: no successor invented — gap is recorded instead', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  // No recommended_engineers should be fabricated
  assert.equal(res.report.recommended_engineers.length, 0, 'no successors should be invented');

  // Gap must mention no successor recorded
  const successorGap = res.report.gaps.find((g) => /successor|backup/i.test(g));
  assert.ok(successorGap, 'missing gap about no recorded successor');
});

test('sole maintainer: unowned service surfaces as a gap, not a fact', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  // Fraud Check Service has no maintainer — must be a gap
  const unownedGap = res.report.gaps.find((g) => g.includes('Fraud Check Service'));
  assert.ok(unownedGap, 'unowned service should surface as a gap');

  // Must NOT be in facts
  const unownedFact = res.report.facts.find((f) => f.text.includes('Fraud Check Service') && /no.*maintainer/i.test(f.text));
  assert.equal(unownedFact, undefined, 'unowned service should not be a fact');
});

test('multiple maintainers: covered service does not appear in solo facts', async () => {
  const run = fakeRun({ get_offboarding_risk: rileyWithBackup() });
  const res = await investigate(Q_RILEY, { run });

  assert.equal(res.mode, 'graph-only');

  // soloMaintained is empty — no solo single-point-of-failure fact expected
  const soloFact = res.report.facts.find((f) => /single-point/i.test(f.text));
  assert.equal(soloFact, undefined, 'should not report a solo single-point-of-failure when another maintainer exists');
});

test('multiple maintainers: report still contains a fact about the service coverage', async () => {
  const run = fakeRun({ get_offboarding_risk: rileyWithBackup() });
  const res = await investigate(Q_RILEY, { run });

  // The ownedServices fact should still appear (listing Auth Service with its backup)
  const coverageFact = res.report.facts.find((f) => f.text.includes('Riley Moss') && f.text.includes('Auth Service'));
  assert.ok(coverageFact, 'should have a fact describing which services Riley maintains');
  assert.ok(coverageFact.evidence.length > 0, 'coverage fact should cite evidence');
});

test('unknown engineer: returns limitation result without crashing', async () => {
  // Override get_engineers to return empty so no name matches "Alex Unknown"
  const run = fakeRun({
    get_engineers: () => ({ engineers: [], service: 'Payment Service', searchedServices: [] }),
  });
  const res = await investigate(Q_UNKNOWN, { run });

  assert.equal(res.mode, 'graph-only');
  // Should report a gap, not an error
  assert.ok(res.report.gaps.length > 0, 'should have gaps explaining no match');
  // Summary should reference the mismatch
  assert.ok(
    /no engineer/i.test(res.report.summary) || res.report.gaps.some((g) => /no engineer/i.test(g)),
    'should explain that no engineer name was matched',
  );
});

test('evidence traceability: every fact and hypothesis has at least one ID from the evidence list', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  const knownIds = new Set(res.evidence.map((e) => e.id));

  for (const fact of res.report.facts) {
    assert.ok(fact.evidence.length > 0, `fact lacks evidence IDs: "${fact.text}"`);
    for (const id of fact.evidence) {
      assert.ok(knownIds.has(id), `unknown evidence ID ${id} in fact: "${fact.text}"`);
    }
  }

  for (const hyp of res.report.hypotheses) {
    assert.ok(hyp.evidence.length > 0, `hypothesis lacks evidence IDs: "${hyp.text}"`);
    for (const id of hyp.evidence) {
      assert.ok(knownIds.has(id), `unknown evidence ID ${id} in hypothesis: "${hyp.text}"`);
    }
  }
});

test('graph-only fallback: offboarding intent correctly detected and routed', async () => {
  const calls = [];
  const run = async (name, input) => {
    calls.push(name);
    return fakeRun({ get_offboarding_risk: averySolo() })(name, input);
  };

  delete process.env.GROQ_API_KEY; // ensure graph-only mode
  const res = await investigate(Q_AVERY, { run });

  assert.equal(res.mode, 'graph-only');
  assert.ok(calls.includes('get_offboarding_risk'), 'get_offboarding_risk should have been called');
  // search_services should also have been called (to build the engineer scan)
  assert.ok(calls.includes('search_services'), 'search_services should have been called');
});

test('report shape is preserved: all required fields present', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  assert.ok(typeof res.report.summary === 'string');
  assert.ok(Array.isArray(res.report.affected_services));
  assert.ok(Array.isArray(res.report.facts));
  assert.ok(Array.isArray(res.report.hypotheses));
  assert.ok(Array.isArray(res.report.recommended_engineers));
  assert.ok(Array.isArray(res.report.next_steps));
  assert.ok(Array.isArray(res.report.gaps));
  assert.ok(Array.isArray(res.evidence));
});

test('uniquely investigated incident surfaces as a verified fact with evidence ID', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  const incFact = res.report.facts.find((f) => f.text.includes('INC-115'));
  assert.ok(incFact, 'uniquely investigated incident should be a fact');
  assert.ok(incFact.evidence.length > 0, 'incident fact must cite evidence');

  const knownIds = new Set(res.evidence.map((e) => e.id));
  for (const id of incFact.evidence) {
    assert.ok(knownIds.has(id), `evidence ID ${id} not found in evidence list`);
  }
});

test('recent deployment surfaces as a verified fact with evidence ID', async () => {
  const run = fakeRun({ get_offboarding_risk: averySolo() });
  const res = await investigate(Q_AVERY, { run });

  const depFact = res.report.facts.find((f) => f.text.includes('DEP-2041'));
  assert.ok(depFact, 'recent deployment should be a fact');
  assert.ok(depFact.evidence.length > 0, 'deployment fact must cite evidence');
});
