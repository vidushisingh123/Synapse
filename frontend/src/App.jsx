import { useEffect, useMemo, useRef, useState } from 'react';
import GraphView from './GraphView.jsx';
import EvidenceItem from './EvidenceView.jsx';
import { MAX_HISTORY, formatWhen, loadHistory, makeEntry, saveHistory } from './history.js';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const DEMO =
  'Checkout is failing. Investigate the likely cause, identify affected services, find relevant past incidents, and recommend who should investigate it.';

// Sample questions grouped by capability — shown on the empty state
const SAMPLE_GROUPS = [
  {
    label: 'Incident investigation',
    questions: [
      DEMO,
      'Why is Checkout API experiencing elevated latency?',
      'What do we know about refund processing incidents?',
    ],
  },
  {
    label: 'Dependency impact',
    questions: [
      'What could be affected if Payment Service becomes unavailable?',
      'Which recent deployments are relevant to authentication failures?',
    ],
  },
  {
    label: 'Ownership & continuity',
    questions: [
      'If Avery Chen leaves next week, what knowledge is at risk and what handover tasks are most urgent?',
      'What services does Riley Moss maintain?',
      'What ownership gaps exist in the graph?',
    ],
  },
];

// Flat list kept for any code that iterates SAMPLES
const SAMPLES = SAMPLE_GROUPS.flatMap((g) => g.questions);

async function api(path, options) {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const list = (v) => (Array.isArray(v) ? v : []);

// Small inline icon set (no dependency) — all share one stroke style
const ICONS = {
  plus:  <path d="M12 5v14M5 12h14" />,
  menu:  <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  graph: (
    <>
      <circle cx="6" cy="7" r="2.2" /><circle cx="18" cy="6" r="2.2" /><circle cx="12" cy="18" r="2.2" />
      <path d="M8 7.6l8 -1M7.2 8.8l3.6 7.2M16.8 8l-3.6 8" />
    </>
  ),
};
function Icon({ name }) {
  return (
    <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {ICONS[name]}
    </svg>
  );
}

function jumpToEvidence(e, id) {
  e.preventDefault();
  const el = document.getElementById(`ev-${id}`);
  if (!el) return;
  el.open = true;
  el.scrollIntoView?.({ behavior: 'smooth', block: 'center' });
  el.classList.remove('flash');
  void el.offsetWidth; // restart the animation
  el.classList.add('flash');
}

function Cites({ ids }) {
  return list(ids).map((id) => (
    <a key={id} className="cite" href={`#ev-${id}`} onClick={(e) => jumpToEvidence(e, id)}>{id}</a>
  ));
}

function ModeBadge({ entry }) {
  if (entry.mode === 'llm') return <span className="badge ai">AI agent{entry.model ? ` \u00b7 ${entry.model}` : ''}</span>;
  if (entry.mode === 'graph-only') return <span className="badge graph">Graph-only</span>;
  return null;
}

const RC_LABELS = {
  confirmed: { label: 'Confirmed',    cls: 'rc-confirmed' },
  likely:    { label: 'Likely cause', cls: 'rc-likely'    },
  possible:  { label: 'Possible',     cls: 'rc-possible'  },
  unknown:   { label: 'Unknown',      cls: 'rc-unknown'   },
};

function RootCauseSection({ rc }) {
  if (!rc) return null;
  const { label, cls } = RC_LABELS[rc.confidence] ?? RC_LABELS.unknown;
  return (
    <section className="card root-cause" aria-label="Root-cause assessment">
      <h2>Root-cause assessment</h2>
      <div className="rc-header">
        <span className={`rc-badge ${cls}`}>{label}</span>
        <p className="rc-assessment">{rc.assessment || 'No assessment available.'}</p>
      </div>
      {rc.causal_chain && (
        <div className="rc-chain">
          <span className="rc-label">Causal chain</span>
          <p>{rc.causal_chain}</p>
        </div>
      )}
      {list(rc.evidence).length > 0 && (
        <div className="rc-evidence">
          <span className="rc-label">Supporting evidence</span>
          <span>{list(rc.evidence).map((id) => <Cites key={id} ids={[id]} />)}</span>
        </div>
      )}
      {list(rc.to_confirm).length > 0 && (
        <div className="rc-to-confirm">
          <span className="rc-label">To confirm</span>
          <ul className="list">
            {list(rc.to_confirm).map((s, i) => <li key={i}>{s}</li>)}
          </ul>
        </div>
      )}
    </section>
  );
}

function Report({ entry }) {
  const r = entry.report;
  const facts   = list(r.facts);
  const hyps    = list(r.hypotheses);
  const services= list(r.affected_services);
  const people  = list(r.recommended_engineers);
  const steps   = list(r.next_steps);
  const gaps    = list(r.gaps);
  // Skip malformed evidence records (null / no id) so one bad entry cannot break the report.
  const evidence= list(entry.evidence).filter((ev) => ev && typeof ev === 'object' && ev.id != null);

  return (
    <>
      {/* Graph-only or tool-skip fallback notice */}
      {entry.warning && (
        <div className="banner warn" role="status" aria-live="polite">
          {entry.warning}
        </div>
      )}

      {/* ── 1. Summary ─────────────────────────────────────────── */}
      <section className="card" aria-label="Investigation summary">
        <h2>Summary</h2>
        <p className="summary">{r.summary || 'No summary was returned.'}</p>
        {services.length > 0 && (
          <div className="chips chips-inline" aria-label="Affected services">
            <span className="chips-label">Affected services</span>
            {services.map((s) => <span className="chip" key={s}>{s}</span>)}
          </div>
        )}
      </section>

      {/* ── 2. Root-cause assessment (omitted for non-failure questions) ── */}
      <RootCauseSection rc={r.root_cause} />

      {/* ── 3. Key findings + Hypotheses ────────────────────────── */}
      <div className={`grid${hyps.length ? '' : ' grid-single'}`}>
        <section className="card" aria-label="Key findings">
          <h2>
            Key findings <span className="tag">supported by graph evidence</span>
          </h2>
          <ul className="list facts-list">
            {facts.map((f, i) => <li key={i}>{f.text}<Cites ids={f.evidence} /></li>)}
            {!facts.length && <li className="empty-item">No graph-supported findings recorded.</li>}
          </ul>
        </section>

        {hyps.length > 0 && (
          <section className="card" aria-label="Hypotheses">
            <h2>Hypotheses <span className="tag">inferred, unconfirmed</span></h2>
            <ul className="list hyps-list">
              {hyps.map((h, i) => (
                <li key={i}>
                  <span className={`conf ${h.confidence}`}>{h.confidence || 'low'}</span>
                  {h.text}<Cites ids={h.evidence} />
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      {/* ── 4. Contacts & ownership (only when non-empty) ─────── */}
      {people.length > 0 && (
        <section className="card" aria-label="Contacts and ownership">
          <h2>Contacts &amp; ownership</h2>
          <ul className="list eng-list">
            {people.map((e, i) => (
              <li key={`${e.name}-${i}`}>
                <strong className="eng-name">{e.name}</strong>
                <span className="eng-reason">{e.reason}</span>
                <Cites ids={e.evidence} />
              </li>
            ))}
          </ul>
        </section>
      )}

      {/* ── 5. Next steps + Knowledge gaps ──────────────────────── */}
      {(steps.length > 0 || gaps.length > 0) && (
        <div className="grid">
          {steps.length > 0 && (
            <section className="card" aria-label="Next steps">
              <h2>Next steps</h2>
              <ol className="list steps-list">
                {steps.map((s, i) => <li key={i}>{s}</li>)}
              </ol>
            </section>
          )}
          {gaps.length > 0 && (
            <section className="card" aria-label="Knowledge gaps">
              <h2>Knowledge gaps</h2>
              <ul className="list gaps-list">
                {gaps.map((s, i) => <li key={i}>{s}</li>)}
              </ul>
            </section>
          )}
        </div>
      )}

      {/* ── 6. Retrieved evidence ────────────────────────────────── */}
      <section className="card" aria-label="Retrieved evidence">
        <h2>Retrieved evidence</h2>
        <div className="evidence">
          {evidence.map((ev) => <EvidenceItem key={ev.id} ev={ev} />)}
          {!evidence.length && <p className="muted">No evidence was recorded for this investigation.</p>}
        </div>
      </section>
    </>
  );
}

export default function App() {
  const [history, setHistory]   = useState(loadHistory);
  const [activeId, setActiveId] = useState(null); // null = new investigation
  const [question, setQuestion] = useState('');
  const [loading, setLoading]   = useState(false);
  const [error, setError]       = useState('');
  const [graph, setGraph]       = useState({ nodes: [], edges: [] });
  const [health, setHealth]     = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [navOpen, setNavOpen]   = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const skipFirstSave = useRef(true);
  const inFlight      = useRef(false);
  const inputRef      = useRef(null);

  useEffect(() => {
    let alive = true;
    api('/api/health')
      .then((h) => alive && setHealth(h))
      .catch((e) => alive && setHealth({ status: 'down', error: e.message }));
    api('/api/graph').then((g) => alive && setGraph(g)).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Persist history whenever it changes (skip the initial read-back).
  useEffect(() => {
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    setStorageOk(saveHistory(history));
  }, [history]);

  const active = useMemo(
    () => history.find((h) => h.id === activeId) ?? null,
    [history, activeId],
  );

  const highlight = useMemo(() => {
    if (!active) return new Set();
    const text = JSON.stringify(active.evidence);
    return new Set(graph.nodes.filter((n) => text.includes(n.name)).map((n) => n.id));
  }, [active, graph]);

  function openEntry(entry) {
    setActiveId(entry.id);
    setQuestion(entry.prompt);
    setError('');
    setConfirmId(null);
    setNavOpen(false);
  }

  function newInvestigation() {
    setActiveId(null);
    setQuestion('');
    setError('');
    setConfirmId(null);
    setNavOpen(false);
    inputRef.current?.focus();
  }

  function removeEntry(id) {
    setHistory((h) => h.filter((x) => x.id !== id));
    setConfirmId(null);
    if (id === activeId) { setActiveId(null); setQuestion(''); }
  }

  async function submit(e) {
    e?.preventDefault();
    const q = question.trim();
    if (inFlight.current || q.length < 5) return;
    inFlight.current = true;
    setLoading(true);
    setError('');
    try {
      const res = await api('/api/investigate', { method: 'POST', body: JSON.stringify({ question: q }) });
      if (!res || typeof res.report !== 'object' || res.report === null) {
        throw new Error('The server returned no report.');
      }
      const entry = makeEntry(q, res);
      setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
      setActiveId(entry.id);
    } catch (err) {
      setError(err.message);
    } finally {
      inFlight.current = false;
      setLoading(false);
    }
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submit(e);
  };

  return (
    <div className="shell">
      {navOpen && <div className="scrim" onClick={() => setNavOpen(false)} />}

      {/* ── Sidebar: brand + history ──────────────────────────── */}
      <aside className={`sidebar on-dark ${navOpen ? 'open' : ''}`} aria-label="Investigation history">
        <div className="brand">
          <span className="logo" aria-hidden="true"><Icon name="graph" /></span>
          <div>
            <strong>Synapse</strong>
            <small>NexusPay knowledge graph</small>
          </div>
        </div>

        <button type="button" className="primary new-btn" onClick={newInvestigation}>
          <Icon name="plus" />New investigation
        </button>

        <h3 className="side-title">Recent investigations</h3>
        <ul className="history">
          {history.map((h) => (
            <li key={h.id} className={h.id === activeId ? 'active' : ''}>
              {confirmId === h.id ? (
                <div className="confirm" role="alertdialog" aria-label="Confirm delete">
                  <span>Delete this investigation?</span>
                  <div>
                    <button type="button" className="danger" onClick={() => removeEntry(h.id)}>Delete</button>
                    <button type="button" onClick={() => setConfirmId(null)}>Cancel</button>
                  </div>
                </div>
              ) : (
                <>
                  <button type="button" className="hist-open" onClick={() => openEntry(h)}
                    aria-current={h.id === activeId ? 'true' : undefined} title={h.prompt}>
                    <span className="hist-title">{h.title}</span>
                    <span className="hist-meta">
                      <i className={`status ${h.mode === 'llm' ? 'ai' : 'graph'}`} />
                      {h.mode === 'llm' ? 'AI' : h.mode === 'graph-only' ? 'Graph' : 'Done'}
                      {' '}&middot;{' '}{formatWhen(h.createdAt)}
                    </span>
                  </button>
                  <button type="button" className="hist-del" aria-label={`Delete ${h.title}`}
                    onClick={() => setConfirmId(h.id)}>
                    <Icon name="close" />
                  </button>
                </>
              )}
            </li>
          ))}
          {!history.length && (
            <li className="side-empty">No investigations yet. Run one and it will appear here.</li>
          )}
        </ul>
        {!storageOk && (
          <p className="side-note">History could not be saved in this browser; it will be lost on refresh.</p>
        )}
      </aside>

      {/* ── Main workspace ────────────────────────────────────── */}
      <main className="main">
        <header className="topbar">
          <button type="button" className="menu-btn" aria-label="Open history" onClick={() => setNavOpen(true)}>
            <Icon name="menu" />
          </button>
          <div className="heading">
            <h1>{active ? active.title : 'New investigation'}</h1>
            <p>
              {active
                ? <>{formatWhen(active.createdAt)} <ModeBadge entry={active} /></>
                : 'Ask about failures, dependencies, past incidents, or ownership. Every finding links back to evidence retrieved from the graph.'}
            </p>
          </div>
          <span className={`pill ${health?.status === 'ok' ? 'ok' : health ? 'down' : ''}`}>
            {!health && 'Connecting\u2026'}
            {health?.status === 'ok' && (
              `Graph \u00b7 ${health.nodes} nodes${health.llmConfigured ? '' : ' \u00b7 graph-only mode'}`
            )}
            {health && health.status !== 'ok' && 'Backend or FalkorDB unreachable'}
          </span>
        </header>

        {/* Question form */}
        <form className="card ask" onSubmit={submit}>
          <textarea
            ref={inputRef}
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            onKeyDown={onKeyDown}
            maxLength={500}
            aria-label="Investigation question"
            placeholder={'Ask about a failure, dependency impact, or ownership \u2014 e.g. \u201cWhy is Checkout API slow?\u201d'}
          />
          <div className="row">
            <button className="primary" disabled={loading || question.trim().length < 5}>
              {loading ? 'Investigating\u2026' : active ? 'Run as new investigation' : 'Investigate'}
            </button>
            <span className="muted hint">Ctrl/&#8984; + Enter &middot; {question.length}/500</span>
          </div>
        </form>

        {error && <div className="banner error" role="alert">{error}</div>}

        {loading && (
          <div className="card loading" role="status" aria-live="polite">
            <div className="bar" />
            <p>Querying the graph and building the report&hellip;</p>
          </div>
        )}

        {/* Empty state: grouped sample questions */}
        {!active && !loading && (
          <section className="card empty" aria-label="Example questions">
            <h2>Start from an example</h2>
            <p className="muted">
              Pick a question to load it into the editor, then run it. Completed investigations are saved in the sidebar.
            </p>
            <div className="sample-groups">
              {SAMPLE_GROUPS.map((g) => (
                <div key={g.label} className="sample-group">
                  <p className="sample-group-label">{g.label}</p>
                  <div className="samples">
                    {g.questions.map((s) => (
                      <button type="button" key={s} className="sample"
                        onClick={() => { setQuestion(s); inputRef.current?.focus(); }}>
                        {s}
                      </button>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </section>
        )}

        {active && <Report key={active.id} entry={active} />}

        <section className="card" aria-label="Knowledge graph visualisation">
          <h2>
            Knowledge graph
            <span className="tag">{active ? 'nodes cited as evidence are highlighted' : 'nodes and relationships'}</span>
          </h2>
          <GraphView nodes={graph.nodes} edges={graph.edges} highlight={highlight} />
        </section>
      </main>
    </div>
  );
}
