import { useEffect, useMemo, useState } from 'react';
import GraphView from './GraphView.jsx';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const DEMO =
  'Checkout is failing. Investigate the likely cause, identify affected services, find relevant past incidents, and recommend who should investigate it.';

async function api(path, options) {
  const res = await fetch(`${API}${path}`, { headers: { 'Content-Type': 'application/json' }, ...options });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed (${res.status})`);
  return body;
}

function Cites({ ids = [] }) {
  return ids.map((id) => (
    <a key={id} className="cite" href={`#ev-${id}`}>{id}</a>
  ));
}

export default function App() {
  const [question, setQuestion] = useState(DEMO);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [result, setResult] = useState(null);
  const [graph, setGraph] = useState({ nodes: [], edges: [] });
  const [health, setHealth] = useState(null);

  useEffect(() => {
    api('/api/health').then(setHealth).catch((e) => setHealth({ status: 'down', error: e.message }));
    api('/api/graph').then(setGraph).catch(() => {});
  }, []);

  async function investigate(e) {
    e.preventDefault();
    setLoading(true);
    setError('');
    try {
      setResult(await api('/api/investigate', { method: 'POST', body: JSON.stringify({ question }) }));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  const highlight = useMemo(() => {
    if (!result) return new Set();
    const text = JSON.stringify(result.evidence);
    return new Set(graph.nodes.filter((n) => text.includes(n.name)).map((n) => n.id));
  }, [result, graph]);

  const r = result?.report;

  return (
    <main className="app">
      <header className="topbar">
        <div>
          <h1>Synapse</h1>
          <p>Graph-powered investigation for your organization</p>
        </div>
        <span className={`pill ${health?.status === 'ok' ? 'ok' : health ? 'down' : ''}`}>
          {!health && 'Connecting…'}
          {health?.status === 'ok' && `Graph connected · ${health.nodes} nodes`}
          {health && health.status !== 'ok' && 'Backend or FalkorDB unreachable'}
        </span>
      </header>

      <form className="card ask" onSubmit={investigate}>
        <textarea value={question} onChange={(e) => setQuestion(e.target.value)} maxLength={500}
          aria-label="Investigation question" placeholder="Describe the problem to investigate…" />
        <div className="row">
          <button className="primary" disabled={loading || question.trim().length < 5}>
            {loading ? 'Investigating…' : 'Investigate'}
          </button>
          <button type="button" onClick={() => setQuestion(DEMO)}>Use demo question</button>
        </div>
      </form>

      {error && <div className="banner error" role="alert">{error}</div>}
      {result?.warning && <div className="banner warn">{result.warning}</div>}

      {r && (
        <>
          <section className="card">
            <h2>Summary · {result.mode === 'llm' ? `AI agent (${result.model})` : 'graph-only'}</h2>
            <p className="summary">{r.summary}</p>
          </section>

          <div className="grid">
            <section className="card">
              <h2>Facts (from the graph)</h2>
              <ul className="list">
                {r.facts.map((f, i) => <li key={i}>{f.text}<Cites ids={f.evidence} /></li>)}
                {!r.facts.length && <li className="muted">No cited facts.</li>}
              </ul>
            </section>
            <section className="card">
              <h2>Hypotheses (inferred)</h2>
              <ul className="list">
                {r.hypotheses.map((h, i) => (
                  <li key={i}><span className={`conf ${h.confidence}`}>{h.confidence}</span>{h.text}<Cites ids={h.evidence} /></li>
                ))}
                {!r.hypotheses.length && <li className="muted">None.</li>}
              </ul>
            </section>
          </div>

          <div className="grid">
            <section className="card">
              <h2>Affected services</h2>
              <div className="chips">
                {r.affected_services.map((s) => <span className="chip" key={s}>{s}</span>)}
                {!r.affected_services.length && <span className="muted">None identified.</span>}
              </div>
            </section>
            <section className="card">
              <h2>Who should investigate</h2>
              <ul className="list">
                {r.recommended_engineers.map((e) => (
                  <li key={e.name}><strong>{e.name}</strong> - {e.reason}<Cites ids={e.evidence} /></li>
                ))}
                {!r.recommended_engineers.length && <li className="muted">No recommendation.</li>}
              </ul>
            </section>
          </div>

          {(r.next_steps.length > 0 || r.gaps.length > 0) && (
            <div className="grid">
              <section className="card">
                <h2>Next steps</h2>
                <ul className="list">{r.next_steps.map((s, i) => <li key={i}>{s}</li>)}</ul>
              </section>
              <section className="card">
                <h2>Evidence gaps</h2>
                <ul className="list">
                  {r.gaps.map((s, i) => <li key={i}>{s}</li>)}
                  {!r.gaps.length && <li className="muted">None reported.</li>}
                </ul>
              </section>
            </div>
          )}

          <section className="card">
            <h2>Retrieved evidence</h2>
            <div className="evidence">
              {result.evidence.map((ev) => (
                <details key={ev.id} id={`ev-${ev.id}`}>
                  <summary><strong>{ev.id}</strong> · {ev.tool}({JSON.stringify(ev.input)})</summary>
                  <pre>{JSON.stringify(ev.data, null, 2)}</pre>
                </details>
              ))}
            </div>
          </section>
        </>
      )}

      <section className="card">
        <h2>Knowledge graph {result ? '· evidence highlighted' : ''}</h2>
        <GraphView nodes={graph.nodes} edges={graph.edges} highlight={highlight} />
      </section>
    </main>
  );
}