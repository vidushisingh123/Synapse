// Run with: npm test   (Node's built-in test runner; no extra dependencies, no network, no FalkorDB)
import test, { beforeEach, mock } from 'node:test';
import assert from 'node:assert/strict';
import { investigate, isRateLimit, parseRetryDelayMs } from '../src/agent.js';

const KEY = 'gsk_test_secret_123';
beforeEach(() => {
  process.env.GROQ_API_KEY = KEY; // dummy; every test injects a fake client, so nothing reaches Groq
  mock.restoreAll();
});

// ---- fakes -------------------------------------------------------------------------------------
function fakeRun() {
  const calls = [];
  const run = async (name) => {
    calls.push(name);
    switch (name) {
      case 'search_services': return { services: ['Checkout API', 'Payment Service'] };
      case 'get_service_dependencies': return { service: 'Checkout API', dependsOn: [{ name: 'Payment Service', depth: 1 }], dependents: [] };
      case 'get_related_incidents': return { service: 'Checkout API', searchedServices: [], incidents: [] };
      case 'get_recent_deployments': return { service: 'Checkout API', searchedServices: [], deployments: [] };
      case 'get_repositories': return { service: 'Checkout API', repositories: [], servicesWithoutRepository: [] };
      case 'get_engineers': return { service: 'Checkout API', searchedServices: [], engineers: [] };
      default: throw new Error(`unexpected tool ${name}`);
    }
  };
  run.calls = calls;
  return run;
}

const rateLimit = ({ header, message = 'Rate limit reached for model on tokens per minute (TPM).' } = {}) =>
  Object.assign(new Error(`429 ${message}`), {
    status: 429,
    headers: header == null ? {} : { 'retry-after': String(header) },
    error: { message, type: 'tokens', code: 'rate_limit_exceeded' },
  });

const toolTurn = (name, args) => ({
  model: 'openai/gpt-oss-120b',
  choices: [{ message: { content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] } }],
});
const finalTurn = (report) => ({ model: 'openai/gpt-oss-120b', choices: [{ message: { content: JSON.stringify(report) } }] });
const REPORT = {
  summary: 'ok', affected_services: ['Checkout API'],
  facts: [{ text: 'Checkout depends on Payment Service', evidence: ['E1'] }],
  hypotheses: [], recommended_engineers: [], next_steps: [], gaps: [],
};

function fakeClient(script) {
  const calls = [];
  return {
    calls,
    chat: { completions: { create: async (params) => {
      calls.push(params);
      const next = script.shift();
      if (!next) throw new Error('fake client script exhausted');
      if (next instanceof Error) throw next;
      return next;
    } } },
  };
}
const fakeSleep = () => { const s = async (ms) => { s.calls.push(ms); }; s.calls = []; return s; };
const Q = 'Checkout is failing. Investigate it.';

// ---- detection and retry-delay parsing ---------------------------------------------------------
test('isRateLimit detects 429 only', () => {
  assert.equal(isRateLimit(rateLimit()), true);
  assert.equal(isRateLimit(Object.assign(new Error('x'), { error: { code: 'rate_limit_exceeded' } })), true);
  assert.equal(isRateLimit(Object.assign(new Error('x'), { status: 500 })), false);
  assert.equal(isRateLimit(Object.assign(new Error('x'), { status: 401 })), false);
  assert.equal(isRateLimit(new Error('plain')), false);
  assert.equal(isRateLimit(undefined), false);
});

test('parseRetryDelayMs reads headers (object and Headers) and message text', () => {
  assert.equal(parseRetryDelayMs({ headers: { 'retry-after': '3' } }), 3000);
  assert.equal(parseRetryDelayMs({ headers: new Headers({ 'retry-after': '1.5' }) }), 1500);
  assert.equal(parseRetryDelayMs({ message: 'Please try again in 5.43s.' }), 5430);
  assert.equal(parseRetryDelayMs({ message: 'Please try again in 450ms.' }), 450);
  assert.equal(parseRetryDelayMs({ error: { message: 'Please try again in 1m2.5s.' } }), 62500);
  assert.equal(parseRetryDelayMs({ headers: { 'retry-after': 'abc' }, message: 'Please try again in 2s.' }), 2000);
});

test('parseRetryDelayMs rejects missing or invalid guidance', () => {
  assert.equal(parseRetryDelayMs({}), null);
  assert.equal(parseRetryDelayMs(undefined), null);
  assert.equal(parseRetryDelayMs({ headers: { 'retry-after': '-4' } }), null);
  assert.equal(parseRetryDelayMs({ headers: { 'retry-after': '0' } }), null);
  assert.equal(parseRetryDelayMs({ headers: { 'retry-after': 'abc' } }), null);
  assert.equal(parseRetryDelayMs({ message: 'Rate limit reached.' }), null);
});

// ---- investigate(): retry and fallback ---------------------------------------------------------
test('429 then success: one retry of the same request, tools not replayed, normal AI result', async () => {
  const run = fakeRun();
  const client = fakeClient([rateLimit({ header: 2 }), toolTurn('get_service_dependencies', { service: 'Checkout API' }), finalTurn(REPORT)]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run, client, sleep });

  assert.equal(res.mode, 'llm');
  assert.equal(res.warning, undefined);
  assert.deepEqual(sleep.calls, [2250]); // provider's 2s + 250ms margin
  assert.equal(client.calls.length, 3); // failed call, its single retry, final answer
  assert.deepEqual(run.calls, ['get_service_dependencies']); // the tool ran exactly once
  assert.deepEqual(res.report.facts[0].evidence, ['E1']);
  assert.deepEqual(client.calls[0].messages, client.calls[1].messages); // identical request, nothing replayed
});

test('429 twice: only one retry, then graph-only fallback with a clear rate-limit message', async () => {
  const run = fakeRun();
  const client = fakeClient([rateLimit({ header: 2 }), rateLimit({ header: 2 })]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run, client, sleep });

  assert.equal(sleep.calls.length, 1);
  assert.equal(client.calls.length, 2);
  assert.equal(res.mode, 'graph-only');
  assert.match(res.warning, /temporarily rate-limited/);
  assert.match(res.warning, /about 2s/);
  assert.doesNotMatch(res.warning, /Groq unavailable/);
  assert.equal(res.evidence[0].id, 'E1'); // fresh, self-consistent graph-only evidence
  assert.ok(res.report.facts.length > 0);
});

test('retry budget is per investigation: a later 429 in the same run is not retried', async () => {
  const run = fakeRun();
  const client = fakeClient([rateLimit({ header: 1 }), toolTurn('get_service_dependencies', { service: 'Checkout API' }), rateLimit({ header: 1 })]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run, client, sleep });

  assert.equal(sleep.calls.length, 1);
  assert.equal(client.calls.length, 3);
  assert.equal(res.mode, 'graph-only');
  assert.match(res.warning, /rate-limited/);
});

test('429 without retry guidance is not retried', async () => {
  const client = fakeClient([rateLimit()]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run: fakeRun(), client, sleep });

  assert.equal(sleep.calls.length, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(res.mode, 'graph-only');
  assert.match(res.warning, /temporarily rate-limited/);
  assert.doesNotMatch(res.warning, /try again in/);
});

test('429 asking for a long wait is not retried and reports the wait', async () => {
  const client = fakeClient([rateLimit({ header: 600 })]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run: fakeRun(), client, sleep });

  assert.equal(sleep.calls.length, 0);
  assert.equal(client.calls.length, 1);
  assert.match(res.warning, /about 10 min/);
});

test('non-429 provider failure: no retry, original fallback message', async () => {
  const client = fakeClient([Object.assign(new Error('Internal server error'), { status: 500 })]);
  const sleep = fakeSleep();
  const res = await investigate(Q, { run: fakeRun(), client, sleep });

  assert.equal(sleep.calls.length, 0);
  assert.equal(client.calls.length, 1);
  assert.equal(res.mode, 'graph-only');
  assert.match(res.warning, /^Groq unavailable \(Internal server error\)/);
  assert.doesNotMatch(res.warning, /rate-limited/);
});

test('API key never appears in the warning or the logs', async () => {
  const logged = [];
  mock.method(console, 'error', (...args) => logged.push(args.join(' ')));
  const client = fakeClient([Object.assign(new Error(`Invalid credentials for ${KEY}`), { status: 401 })]);
  const res = await investigate(Q, { run: fakeRun(), client, sleep: fakeSleep() });

  assert.equal(res.mode, 'graph-only');
  assert.doesNotMatch(res.warning, /gsk_test_secret_123/);
  assert.match(res.warning, /\[redacted\]/);
  assert.ok(logged.length > 0);
  assert.ok(logged.every((l) => !l.includes(KEY)));
});