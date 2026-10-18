import { useEffect, useMemo, useRef, useState } from 'react';
import GraphView from './GraphView.jsx';
import { MAX_HISTORY, formatWhen, loadHistory, makeEntry, saveHistory } from './history.js';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const DEMO =
  'Checkout is failing. Investigate the likely cause, identify affected services, find relevant past incidents, and recommend who should investigate it.';
const SAMPLES = [
  DEMO,
  'What does Payment Service depend on?',
  'Who should I ask about Inventory Service?',
  'Tell me about INC-087',
];

async function api(path, options) {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

const list = (v) => (Array.isArray(v) ? v : []);

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
  if (entry.mode === 'llm') return <span className="badge ai">AI agent{entry.model ? ` · ${entry.model}` : ''}</span>;
  if (entry.mode === 'graph-only') return <span className="badge graph">Graph-only</span>;
  return null;
}

function Report({ entry }) {
  const r = entry.report;
  const facts = list(r.facts);
  const hyps = list(r.hypotheses);
  const services = list(r.affected_services);
  const people = list(r.recommended_engineers);
  const steps = list(r.next_steps);
  const gaps = list(r.gaps);
  const evidence = list(entry.evidence);

  return (
    <>
      {entry.warning && <div className="banner warn">{entry.warning}</div>}

      <section className="card">
        <h2>Summary</h2>
        <p className="summary">{r.summary || 'No summary was returned.'}</p>
      </section>

      <div className="grid">
        <section className="card">
          <h2>Key findings <span className="tag">graph-supported</span></h2>
          <ul className="list">
            {facts.map((f, i) => <li key={i}>{f.text}<Cites ids={f.evidence} /></li>)}
            {!facts.length && <li className="muted">No cited findings.</li>}
          </ul>
        </section>
        <section className="card">
          <h2>Hypotheses <span className="tag">inferred, unconfirmed</span></h2>
          <ul className="list">
            {hyps.map((h, i) => (
              <li key={i}>
                <span className={`conf ${h.confidence}`}>{h.confidence || 'low'}</span>{h.text}<Cites ids={h.evidence} />
              </li>
            ))}
            {!hyps.length && <li className="muted">None.</li>}
          </ul>
        </section>
      </div>

      <div className="grid">
        <section className="card">
          <h2>Affected services</h2>
          <div className="chips">
            {services.map((s) => <span className="chip" key={s}>{s}</span>)}
            {!services.length && <span className="muted">None identified.</span>}
          </div>
        </section>
        <section className="card">
          <h2>Recommended engineers</h2>
          <ul className="list">
            {people.map((e, i) => (
              <li key={`${e.name}-${i}`}><strong>{e.name}</strong> - {e.reason}<Cites ids={e.evidence} /></li>
            ))}
            {!people.length && <li className="muted">No recommendation.</li>}
          </ul>
        </section>
      </div>

      {(steps.length > 0 || gaps.length > 0) && (
        <div className="grid">
          <section className="card">
            <h2>Next steps</h2>
            <ul className="list">
              {steps.map((s, i) => <li key={i}>{s}</li>)}
              {!steps.length && <li className="muted">None.</li>}
            </ul>
          </section>
          <section className="card">
            <h2>Knowledge gaps</h2>
            <ul className="list">
              {gaps.map((s, i) => <li key={i}>{s}</li>)}
              {!gaps.length && <li className="muted">None reported.</li>}
            </ul>
          </section>
        </div>
      )}

      <section className="card">
        <h2>Retrieved evidence</h2>
        <div className="evidence">
          {evidence.map((ev) => (
            <details key={ev.id} id={`ev-${ev.id}`}>
              <summary><strong>{ev.id}</strong> · {ev.tool}({JSON.stringify(ev.input)})</summary>
              <pre>{JSON.stringify(ev.data, null, 2)}</pre>
            </details>
          ))}
          {!evidence.length && <p className="muted">No evidence was recorded for this investigation.</p>}
        </div>
      </section>
    </>
  );
}

export default function App() {
  const [history, setHistory] = useState(loadHistory);
  const [activeId, setActiveId] = useState(null); // null = new investigation
  const [question, setQuestion] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [health, setHealth] = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [navOpen, setNavOpen] = useState(false);
  const [storageOk, setStorageOk] = useState(true);
  const skipFirstSave = useRef(true);
  const inFlight = useRef(false); 
  const inputRef = useRef(null);

  useEffect(() => {
    let alive = true;
    api('/api/health').then((h) => alive && setHealth(h)).catch((e) => alive && setHealth({ status: 'down', error: e.message }));
    api('/api/graph').then((g) => alive && setGraph(g)).catch(() => {});
    return () => { alive = false; };
  }, []);

  // Persist history whenever it changes (the initial load is not written back).
  useEffect(() => {
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    setStorageOk(saveHistory(history));
  }, [history]);

  const active = useMemo(() => history.find((h) => h.id === activeId) ?? null, [history, activeId]);

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
    if (id === activeId) {
      setActiveId(null);
      setQuestion('');
    }
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
      const entry = makeEntry(q, res); // a new entry; earlier investigations are never overwritten
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

      <aside className={`sidebar ${navOpen ? 'open' : ''}`} aria-label="Investigation history">
        <div className="brand">
          <span className="logo" aria-hidden="true">S</span>
          <div>
            <strong>Synapse</strong>
            <small>Investigation workspace</small>
          </div>
        </div>

        <button type="button" className="primary new-btn" onClick={newInvestigation}>+ New investigation</button>

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
                      {h.mode === 'llm' ? 'AI' : h.mode === 'graph-only' ? 'Graph' : 'Done'} · {formatWhen(h.createdAt)}
                    </span>
                  </button>
                  <button type="button" className="hist-del" aria-label={`Delete ${h.title}`}
                    onClick={() => setConfirmId(h.id)}>×</button>
                </>
              )}
            </li>
          ))}
          {!history.length && <li className="side-empty">No investigations yet. Run one and it will appear here.</li>}
        </ul>
        {!storageOk && <p className="side-note">History could not be saved in this browser; it will be lost on refresh.</p>}
      </aside>

      <main className="main">
        <header className="topbar">
          <button type="button" className="menu-btn" aria-label="Open history" onClick={() => setNavOpen(true)}>☰</button>
          <div className="heading">
            <h1>{active ? active.title : 'New investigation'}</h1>
            <p>
              {active
                ? <>{formatWhen(active.createdAt)} <ModeBadge entry={active} /></>
                : 'Ask about failures, dependencies, past incidents or owners. Answers are built from graph evidence.'}
            </p>
          </div>
          <span className={`pill ${health?.status === 'ok' ? 'ok' : health ? 'down' : ''}`}>
            {!health && 'Connecting…'}
            {health?.status === 'ok' && `Graph connected · ${health.nodes} nodes`}
            {health && health.status !== 'ok' && 'Backend or FalkorDB unreachable'}
          </span>
        </header>

        <form className="card ask" onSubmit={submit}>
          <textarea ref={inputRef} value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={onKeyDown}
            maxLength={500} aria-label="Investigation question"
            placeholder="Describe the problem to investigate, e.g. “Checkout is failing…”" />
          <div className="row">
            <button className="primary" disabled={loading || question.trim().length < 5}>
              {loading ? 'Investigating…' : active ? 'Run as new investigation' : 'Investigate'}
            </button>
            <span className="muted hint">Ctrl/⌘ + Enter · {question.length}/500</span>
          </div>
        </form>

        {error && <div className="banner error" role="alert">{error}</div>}

        {loading && (
          <div className="card loading" role="status">
            <div className="bar" />
            <p>Querying the graph and building the report…</p>
          </div>
        )}

        {!active && !loading && (
          <section className="card empty">
            <h2>Start an investigation</h2>
            <p className="muted">Pick an example or write your own question. Each investigation is saved to the sidebar and can be reopened without re-running it.</p>
            <div className="samples">
              {SAMPLES.map((s) => (
                <button type="button" key={s} className="sample" onClick={() => { setQuestion(s); inputRef.current?.focus(); }}>{s}</button>
              ))}
            </div>
          </section>
        )}

        {active && <Report key={active.id} entry={active} />}

        <section className="card">
          <h2>Knowledge graph {active ? '· evidence highlighted' : ''}</h2>
          <GraphView nodes={graph.nodes} edges={graph.edges} highlight={highlight} />
        </section>
      </main>
    </div>
  );
}