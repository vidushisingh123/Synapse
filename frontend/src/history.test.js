// Run: node --test src/history.test.js   (from the frontend folder; Node 20+; no extra packages)
// Exercises history.js together with auth.js exactly the way App.jsx uses them: no user id is passed to
// readHistory/saveHistory; the account is the owner marker auth.js records after the session is verified.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as history from './history.js';
import * as auth from './auth.js';

const { MAX_HISTORY, makeEntry, readHistory, loadHistory, saveHistory, saveHistoryDetailed, clearHistory } = history;
const { adoptHistoryOwner, endSession, historyOwner } = auth;

function makeStorage({ limit = Infinity, blocked = false, keepNothing = false } = {}) {
  const m = new Map();
  const s = {
    writes: 0,
    getItem: (k) => (m.has(k) ? m.get(k) : null),
    setItem(k, v) {
      s.writes++;
      if (blocked) throw new DOMException('blocked', 'SecurityError');
      const text = String(v);
      if (text.length > limit) throw new DOMException('full', 'QuotaExceededError');
      if (!keepNothing) m.set(k, text);
    },
    removeItem: (k) => { m.delete(k); },
    key: (i) => [...m.keys()][i] ?? null,
    get length() { return m.size; },
    keys: () => [...m.keys()],
  };
  return s;
}
const install = (name, value) => Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
beforeEach(() => { install('localStorage', makeStorage()); install('sessionStorage', makeStorage()); });

// What App.jsx does when it ends a session / changes account.
const wipe = () => saveHistory([]);
const entry = (n, pad = 0) => ({
  ...makeEntry(`Why is service ${n} slow? Which dependencies matter?`, {
    mode: 'graph-only', warning: 'GROQ_API_KEY is not set. Showing graph-only analysis.',
    report: { summary: `Summary ${n}${'x'.repeat(pad)}`, root_cause: { confidence: 'likely' } },
    evidence: [{ id: 'E1', tool: 'get_related_incidents', input: { service: 'Checkout API' }, data: { incidents: [{ id: 'INC-130' }] } }],
  }),
  graph: { nodes: [{ id: 'Service:Checkout API', label: 'Service', name: 'Checkout API' }], edges: [{ source: 'Incident:INC-130', target: 'Service:Checkout API', type: 'AFFECTS', evidence: ['E1'] }] },
});
const signInAs = (id) => adoptHistoryOwner(id, wipe);

// ------------------------------------------------------------------ the regression
test('App contract: history functions take no user id (the mismatch that broke saving)', () => {
  assert.equal(readHistory.length, 0);
  assert.equal(loadHistory.length, 0);
  assert.equal(saveHistory.length, 1);
  assert.equal(saveHistoryDetailed.length, 1);
  const src = readFileSync(new URL('./App.jsx', import.meta.url), 'utf8');
  for (const m of [...src.matchAll(/import\s*\{([^}]*)\}\s*from\s*'\.\/(history|auth)\.js'/g)]) {
    const exported = m[2] === 'history' ? history : auth;
    for (const n of m[1].split(',').map((x) => x.trim()).filter(Boolean)) assert.ok(n in exported, `App.jsx imports ${n}, which ${m[2]}.js does not export`);
  }
  for (const m of [...src.matchAll(/\b(readHistory|loadHistory|saveHistoryDetailed|saveHistory)\(([^)]*)\)/g)]) {
    assert.ok(m[2].split(',').filter((a) => a.trim()).length <= 1, `${m[1]}(${m[2]}) passes more arguments than history.js accepts`);
  }
});

test('saving as App does returns true, and the investigation survives a "refresh" with results, evidence and graph intact', () => {
  signInAs('u-A');
  const e = entry(1);
  assert.equal(saveHistory([e]), true);
  const after = readHistory();                  // a refresh: App mounts and calls readHistory() with no arguments
  assert.equal(after.problem, null);
  assert.deepEqual(after.entries, [e]);
  assert.equal(after.entries[0].evidence[0].data.incidents[0].id, 'INC-130');
  assert.equal(after.entries[0].graph.edges[0].type, 'AFFECTS');
  assert.deepEqual(loadHistory(), [e]);
});

test('deleting and adding persist; deleting the last entry leaves nothing stored', () => {
  signInAs('u-A');
  const [a, b] = [entry(1), entry(2)];
  assert.equal(saveHistory([b, a]), true);
  assert.equal(saveHistory([a]), true);
  assert.deepEqual(loadHistory().map((x) => x.id), [a.id]);
  assert.equal(saveHistory([]), true);
  assert.deepEqual(loadHistory(), []);
  assert.ok(!localStorage.keys().includes('synapse.history.v2'));
});

test('the list is capped at MAX_HISTORY and that is not reported as a problem', () => {
  signInAs('u-A');
  const many = Array.from({ length: MAX_HISTORY + 10 }, (_, i) => entry(i));
  const r = saveHistoryDetailed(many);
  assert.equal(r.ok, true); assert.equal(r.saved, MAX_HISTORY); assert.equal(r.problem, null);
  assert.equal(loadHistory().length, MAX_HISTORY);
});

// ------------------------------------------------------------------ ownership and isolation
test('no recorded owner: nothing is written and the failure is reported', () => {
  const r = saveHistoryDetailed([entry(1)]);
  assert.equal(r.ok, false); assert.equal(r.saved, 0);
  assert.match(r.problem, /could not be saved/);
  assert.equal(localStorage.keys().length, 0);
});

test('another account never receives saved history: wipe on account change', () => {
  signInAs('u-A');
  saveHistory([entry(1)]);
  signInAs('u-B');                                // different account signs in on the same browser
  assert.deepEqual(loadHistory(), []);
  assert.ok(!localStorage.keys().includes('synapse.history.v2'), 'previous account\'s data was wiped');
  assert.equal(historyOwner(), 'u-B');
});

test('defence in depth: even if the wipe never runs, the other account still gets nothing', () => {
  signInAs('u-A');
  const a = entry(1);
  saveHistory([a]);
  adoptHistoryOwner('u-B', () => {});             // simulate a failed / skipped wipe
  assert.equal(historyOwner(), 'u-B');
  assert.ok(localStorage.keys().includes('synapse.history.v2'));
  assert.deepEqual(readHistory(), { entries: [], problem: null });
  assert.equal(saveHistory([entry(2)]), true);    // B's own save replaces A's envelope
  assert.ok(!JSON.stringify(localStorage.getItem('synapse.history.v2')).includes(a.id));
  adoptHistoryOwner('u-A', wipe);
  assert.deepEqual(loadHistory(), []);
});

test('the same account signing in again keeps its history', () => {
  signInAs('u-A');
  const e = entry(1);
  saveHistory([e]);
  signInAs('u-A');
  assert.deepEqual(loadHistory(), [e]);
});

test('sign-out / expired session removes the history and the owner marker', () => {
  signInAs('u-A');
  sessionStorage.setItem('synapse.token', 't');
  saveHistory([entry(1)]);
  endSession(wipe);
  assert.deepEqual(localStorage.keys().filter((k) => k.startsWith('synapse.history')), []);
  assert.equal(sessionStorage.getItem('synapse.token'), null);
  assert.equal(historyOwner(), null);
  assert.deepEqual(loadHistory(), []);
});

test('unowned legacy history and interim per-user keys are never loaded and are wiped', () => {
  localStorage.setItem('synapse.history.v1', JSON.stringify([entry(9)]));
  sessionStorage.setItem('synapse.history.v2.u-A', JSON.stringify([entry(8)]));
  signInAs('u-A');                                // no owner marker before => wipe runs
  assert.deepEqual(loadHistory(), []);
  assert.equal(localStorage.getItem('synapse.history.v1'), null);
  assert.equal(sessionStorage.getItem('synapse.history.v2.u-A'), null);
});

test('clearHistory leaves the owner marker alone', () => {
  signInAs('u-A');
  saveHistory([entry(1)]);
  assert.equal(clearHistory(), true);
  assert.equal(historyOwner(), 'u-A');
});

// ------------------------------------------------------------------ honest errors
test('corrupt saved data is reported, not silently ignored, and the next save recovers', () => {
  signInAs('u-A');
  localStorage.setItem('synapse.history.v2', '{not json');
  const r = readHistory();
  assert.deepEqual(r.entries, []); assert.match(r.problem, /could not be read/);
  assert.equal(saveHistory([entry(1)]), true);
  assert.equal(readHistory().problem, null);
});

test('unreadable individual entries are skipped and counted', () => {
  signInAs('u-A');
  const good = entry(1);
  localStorage.setItem('synapse.history.v2', JSON.stringify({ v: 2, owner: 'u-A', entries: [good, { id: 5 }, null, { id: 'x', prompt: 'p' }] }));
  const r = readHistory();
  assert.deepEqual(r.entries, [good]);
  assert.match(r.problem, /^3 saved investigations could not be read and were skipped\.$/);
});

test('quota exceeded: the newest entries that fit are kept and the shortfall is stated, never reported as success', () => {
  const list = [5, 4, 3, 2, 1].map((n) => entry(n, 400)); // newest first
  const one = JSON.stringify({ v: 2, owner: 'u-A', entries: [list[0]] }).length;
  install('localStorage', makeStorage({ limit: Math.floor(one * 3.2) }));
  adoptHistoryOwner('u-A', () => {});
  const r = saveHistoryDetailed(list);
  assert.equal(r.ok, false);
  assert.ok(r.saved >= 1 && r.saved < 5, `saved ${r.saved}`);
  assert.equal(r.problem, `Only the ${r.saved} newest of 5 investigations fit in this browser\u2019s storage; older ones will be missing after a refresh.`);
  assert.deepEqual(readHistory().entries.map((e) => e.id), list.slice(0, r.saved).map((e) => e.id));
  assert.equal(saveHistory(list), false);
});

test('blocked storage fails fast and says nothing was saved', () => {
  install('localStorage', makeStorage({ blocked: true }));
  adoptHistoryOwner('u-A', () => {});             // cannot even record the owner
  const r = saveHistoryDetailed([entry(1), entry(2), entry(3)]);
  assert.equal(r.ok, false); assert.equal(r.saved, 0);
  assert.match(r.problem, /could not be saved in this browser; it will be lost on refresh/);
});

test('a write the browser accepts but does not keep is not reported as saved', () => {
  const st = makeStorage();
  const realSet = st.setItem;
  st.setItem = (k, v) => { if (k !== 'synapse.history.v2') realSet(k, v); }; // silently drops the history write
  install('localStorage', st);
  adoptHistoryOwner('u-A', () => {});
  assert.equal(saveHistoryDetailed([entry(1)]).ok, false);
});

test('unavailable storage never throws: load says so, save says nothing was saved', () => {
  Object.defineProperty(globalThis, 'localStorage', { get() { throw new Error('denied'); }, configurable: true });
  assert.match(readHistory().problem, /could not be read/);
  assert.match(saveHistoryDetailed([entry(1)]).problem, /could not be saved/);
  assert.equal(clearHistory(), true);
});

test('wiping works even when storage is completely full', () => {
  signInAs('u-A');
  saveHistory([entry(1)]);
  const full = localStorage;
  full.setItem = () => { throw new DOMException('full', 'QuotaExceededError'); };
  assert.equal(saveHistory([]), true);
  assert.deepEqual(loadHistory(), []);
});
