import { useEffect, useMemo, useRef, useState } from 'react';
import GraphView from './GraphView.jsx';
import EvidenceItem from './EvidenceView.jsx';
import { MAX_HISTORY, formatWhen, makeEntry, readHistory, saveHistory, saveHistoryDetailed } from './history.js';
import { ApiError, adoptHistoryOwner, can, clearToken, endSession, getToken, setToken } from './auth.js';
import Login from './Login.jsx';
import './App.css';

const API = import.meta.env.VITE_API_URL || 'http://localhost:4000';
const REQUEST_TIMEOUT_MS = 120_000; // an investigation can involve several LLM + graph round-trips
const DEMO =
  'Checkout is failing. Investigate the likely cause, identify affected services, find relevant past incidents, and recommend who should investigate it.';

// One-tap starters on the empty state: a short label, plus the full question that is actually sent.
const STARTERS = [
  { label: 'Investigate a checkout failure', topic: 'Incident investigation', question: DEMO },
  { label: 'Impact if Payment Service goes down', topic: 'Dependency impact', question: 'What could be affected if Payment Service becomes unavailable?' },
  { label: 'Past refund processing incidents', topic: 'Past incidents', question: 'What do we know about refund processing incidents?' },
  { label: 'What does Riley Moss maintain?', topic: 'Service ownership', question: 'What services does Riley Moss maintain?' },
];

async function api(path, options) {
  const token = getToken();
  let res;
  try {
    res = await fetch(`${API}${path}`, {
      ...options,
      headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    });
  } catch (err) {
    throw new ApiError(
      err?.name === 'TimeoutError' || err?.name === 'AbortError'
        ? 'The investigation timed out. The backend or the AI model may be slow \u2014 please try again.'
        : `Can\u2019t reach the Synapse API at ${API}. Check that the backend is running, then try again.`,
      0,
    );
  }
  const body = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new ApiError(body.error || `Request failed (${res.status})`, res.status);
    if (typeof body.code === 'string') err.code = body.code;
    throw err;
  }
  return body;
}

const list = (v) => (Array.isArray(v) ? v : []);

// Small inline icon set (no dependency) — all share one stroke style
const ICONS = {
  plus:  <path d="M12 5v14M5 12h14" />,
  menu:  <path d="M4 7h16M4 12h16M4 17h16" />,
  close: <path d="M6 6l12 12M18 6L6 18" />,
  send:  <path d="M12 19V5M5.5 11.5L12 5l6.5 6.5" />,
  mic:   (
    <>
      <rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </>
  ),
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

const REL_VERBS = {
  DEPENDS_ON: 'depends on', AFFECTS: 'affects', INVOLVES: 'involves', DEPLOYED_TO: 'was deployed to',
  IMPLEMENTED_IN: 'is implemented in', MAINTAINS: 'maintains', INVESTIGATED: 'investigated', AUTHORED: 'authored',
};
const REL_ORDER = Object.keys(REL_VERBS);
const REL_PREVIEW = 8;

// Entities and relationships the backend derived from the evidence it retrieved (response.graph).
// Rendered as-is; nothing is inferred here. Older saved entries have no graph and simply skip this card.
function Relationships({ graph }) {
  const [all, setAll] = useState(false);
  const nodes = list(graph?.nodes);
  const edges = list(graph?.edges).filter((e) => e && typeof e.source === 'string' && typeof e.target === 'string');
  if (!edges.length) return null;

  const byId = new Map(nodes.map((n) => [n.id, n]));
  const nameOf = (id) => byId.get(id)?.name ?? id.split(':').slice(1).join(':');
  const kindOf = (id) => byId.get(id)?.label ?? id.split(':')[0];
  const services = nodes.filter((n) => n.label === 'Service');
  const rank = (t) => { const i = REL_ORDER.indexOf(t); return i < 0 ? REL_ORDER.length : i; };
  const sorted = [...edges].sort((a, b) => rank(a.type) - rank(b.type));
  const shown = all ? sorted : sorted.slice(0, REL_PREVIEW);
  const hops = (e) => (e.hops > 1 ? ` (${e.hops} hops)` : e.maxHops ? ` (within ${e.maxHops} hops)` : '');

  return (
    <section className="card" aria-label="Related services and relationships">
      <h2>Related services &amp; relationships <span className="tag">from retrieved evidence</span></h2>
      {services.length > 0 && (
        <div className="chips chips-inline rel-services" aria-label="Services in this investigation">
          <span className="chips-label">Services</span>
          {services.map((n) => <span className="chip" key={n.id}>{n.name}</span>)}
        </div>
      )}
      <ul className="list rel-list">
        {shown.map((e, i) => (
          <li key={`${e.source}|${e.type}|${e.target}|${i}`}>
            <span className="rel-kind">{kindOf(e.source)}</span> <strong>{nameOf(e.source)}</strong>{' '}
            <em>{REL_VERBS[e.type] ?? humanizeRel(e.type)}</em>{' '}
            <span className="rel-kind">{kindOf(e.target)}</span> <strong>{nameOf(e.target)}</strong>{hops(e)}
            <Cites ids={e.evidence} />
          </li>
        ))}
      </ul>
      {edges.length > REL_PREVIEW && (
        <button type="button" className="link-btn" onClick={() => setAll((v) => !v)}>
          {all ? 'Show fewer' : `Show all ${edges.length} relationships`}
        </button>
      )}
    </section>
  );
}
const humanizeRel = (t) => String(t ?? 'relates to').toLowerCase().replace(/_/g, ' ');

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
        {(() => {
          // The graph-only summary ends with an "Interpreted as: ..." diagnostics tail; show it as a quieter second line.
          const text = r.summary || 'No summary was returned.';
          const cut = text.indexOf(' Interpreted as:');
          return cut > 0 ? (
            <>
              <p className="summary">{text.slice(0, cut)}</p>
              <p className="summary-meta">{text.slice(cut + 1)}</p>
            </>
          ) : <p className="summary">{text}</p>;
        })()}
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

      {/* ── 6. Related services and relationships (from the backend's evidence-derived graph) ── */}
      <Relationships graph={entry.graph} />

      {/* ── 7. Retrieved evidence ────────────────────────────────── */}
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

let turnSeq = 0;
const newTurnId = () => `t${Date.now().toString(36)}-${++turnSeq}`;

// Decorative assistant mark. `thinking` spins it while a request is genuinely in flight.
function Orb({ size, thinking }) {
  return <span className={`orb${size ? ` ${size}` : ''}${thinking ? ' spinning' : ''}`} aria-hidden="true" />;
}

// The only progress shown is what is actually known: a request is running and how long it has taken.
function Thinking({ startedAt }) {
  const [secs, setSecs] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setSecs(Math.floor((Date.now() - startedAt) / 1000)), 500);
    return () => clearInterval(t);
  }, [startedAt]);
  return (
    <div className="thinking" role="status" aria-live="polite">
      <span>Querying the graph and building the report&hellip;</span>
      <span className="elapsed">{secs}s</span>
    </div>
  );
}

const snippet = (text, n = 220) => {
  const t = String(text || 'No summary was returned.');
  return t.length > n ? `${t.slice(0, n - 1)}\u2026` : t;
};

function Turn({ turn, open, multi, canAsk, onToggle, onRetry, onAsk }) {
  const { entry } = turn;
  // Follow-up prompts only reuse service names the backend returned for this investigation.
  const services = list(entry?.report?.affected_services).filter((s) => typeof s === 'string').slice(0, 3);
  return (
    <article className="turn" id={`turn-${turn.id}`}>
      <div className="msg user"><div className="bubble">{turn.prompt}</div></div>
      <div className="bot">
        <Orb thinking={turn.status === 'pending'} />
        <div className="bot-body">
          {turn.status === 'pending' && <Thinking startedAt={turn.startedAt} />}

          {turn.status === 'error' && (
            <div className="bot-error">
              <div className="banner error" role="alert">{turn.error}</div>
              {canAsk && <button type="button" onClick={() => onRetry(turn)}>Try again</button>}
            </div>
          )}

          {turn.status === 'done' && entry && (
            <>
              <div className="bot-head">
                <strong>Synapse</strong>
                <ModeBadge entry={entry} />
                <span className="muted when">{formatWhen(entry.createdAt)}</span>
                {multi && (
                  <button type="button" className="link-btn" aria-expanded={open} onClick={onToggle}>
                    {open ? 'Collapse' : 'Expand'}
                  </button>
                )}
              </div>
              {open ? (
                <>
                  <div className="bot-cards"><Report entry={entry} /></div>
                  {canAsk && services.length > 0 && (
                    <div className="dig" aria-label="Follow-up suggestions">
                      <span className="chips-label">Dig deeper</span>
                      {services.map((svc) => (
                        <button type="button" key={svc} className="pill-btn"
                          onClick={() => onAsk(`Why might ${svc} be failing, and what depends on it?`)}>
                          {svc}
                        </button>
                      ))}
                    </div>
                  )}
                </>
              ) : (
                <button type="button" className="collapsed" aria-expanded="false" onClick={onToggle}>
                  <span>{snippet(entry.report?.summary)}</span>
                  <span className="collapsed-cta">Show full report</span>
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </article>
  );
}

// Everything below this point is only ever mounted for a verified session (see App at the bottom), so
// its state (history, thread, graph, evidence, findings) is discarded whenever the session ends.
function Workspace({ me, onSignOut, onAuthLost }) {
  const [initial]               = useState(readHistory); // read once, after the session is verified and its owner recorded
  const [history, setHistory]   = useState(initial.entries);
  const [activeId, setActiveId] = useState(null); // history entry shown last; null = new conversation
  const [thread, setThread]     = useState([]);   // this conversation: [{ id, prompt, status, entry?, error?, startedAt }]
  const [openId, setOpenId]     = useState(null); // the one expanded report (keeps evidence anchors unique)
  const [question, setQuestion] = useState('');
  const [error, setError]       = useState('');
  const [graph, setGraph]       = useState({ nodes: [], edges: [] });
  const [health, setHealth]     = useState(null);
  const [confirmId, setConfirmId] = useState(null);
  const [navOpen, setNavOpen]   = useState(false);
  const [storageNote, setStorageNote] = useState(initial.problem); // honest note when saved history cannot be read or fully written
  const skipFirstSave = useRef(true);
  const inFlight      = useRef(false);
  const inputRef      = useRef(null);
  const loading = thread.some((t) => t.status === 'pending');

  // 401: the session is missing or expired. 403: signed in, but the role does not allow this.
  // Both are enforced by the server; this only explains them to the user.
  function describeError(err) {
    if (err?.status === 401) {
      onAuthLost(); // clears the token and saved history and returns to the sign-in screen
      return 'You are not signed in, or your session has expired. Sign in again to continue.';
    }
    if (err?.status === 403) return err.message || 'Your role does not permit this action.';
    return err?.message || 'Something went wrong.';
  }

  useEffect(() => {
    let alive = true;
    api('/api/health')
      .then((h) => alive && setHealth(h))
      .catch((e) => alive && setHealth({ status: 'down', error: e.message }));
    api('/api/graph')
      .then((g) => alive && setGraph(g))
      .catch((e) => {
        if (!alive) return;
        if (e?.status === 401) onAuthLost();
        else if (e?.status === 403) setError(e.message);
      });
    return () => { alive = false; };
  }, []);

  // Usability only: the server rejects investigations from roles without this permission anyway.
  const canInvestigate = can(me, 'investigate');
  const roleNote = !canInvestigate
    ? `Your role (${me.user.role}) can explore the knowledge graph but cannot run investigations.`
    : null;

  // Persist history whenever it changes (skip the initial read-back).
  useEffect(() => {
    if (skipFirstSave.current) { skipFirstSave.current = false; return; }
    setStorageNote(saveHistoryDetailed(history).problem ?? initial.problem);
  }, [history]);

  // The most recent completed answer drives the header and the graph highlight.
  const active = useMemo(
    () => [...thread].reverse().find((t) => t.status === 'done')?.entry ?? null,
    [thread],
  );

  const highlight = useMemo(() => {
    if (!active) return new Set();
    const text = JSON.stringify(active.evidence);
    const ids = new Set(graph.nodes.filter((n) => text.includes(n.name)).map((n) => n.id));
    // Entities the backend reported for this answer (same Label:name ids as /api/graph).
    const known = new Set(graph.nodes.map((n) => n.id));
    list(active.graph?.nodes).forEach((n) => { if (n && known.has(n.id)) ids.add(n.id); });
    return ids;
  }, [active, graph]);

  // Keep the newest turn in view: the thinking indicator while waiting, the top of the answer once it arrives.
  const threadKey = thread.map((t) => `${t.id}:${t.status}`).join('|');
  useEffect(() => {
    const last = thread[thread.length - 1];
    if (!last) return;
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById(`turn-${last.id}`)?.scrollIntoView?.({
      behavior: calm ? 'auto' : 'smooth',
      block: last.status === 'done' ? 'start' : 'end',
    });
  }, [threadKey]);

  // Grow the composer with its content (up to 160px).
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${Math.min(el.scrollHeight, 160)}px`;
  }, [question]);

  // Landing: put the cursor in the composer on devices with a precise pointer (not on touch, where it opens the keyboard).
  useEffect(() => {
    if (!thread.length && canInvestigate && window.matchMedia?.('(pointer: fine)').matches) inputRef.current?.focus();
  }, [thread.length, canInvestigate]);

  function jumpToGraph() {
    const calm = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    document.getElementById('knowledge-graph')?.scrollIntoView?.({ behavior: calm ? 'auto' : 'smooth', block: 'start' });
  }

  function openEntry(entry) {
    const id = `t-${entry.id}`;
    setThread([{ id, prompt: entry.prompt, status: 'done', entry }]);
    setOpenId(id);
    setActiveId(entry.id);
    setQuestion('');
    setError('');
    setConfirmId(null);
    setNavOpen(false);
  }

  function newInvestigation() {
    setThread([]);
    setOpenId(null);
    setActiveId(null);
    setQuestion('');
    setError('');
    setConfirmId(null);
    setNavOpen(false);
    inputRef.current?.focus();
  }

  function removeEntry(id) {
    setHistory((h) => h.filter((x) => x.id !== id));
    setThread((t) => t.filter((x) => x.entry?.id !== id));
    setConfirmId(null);
    if (id === activeId) setActiveId(null);
  }

  // One question -> one POST /api/investigate { question }. The backend does the work and the authorization.
  async function ask(raw, retryOf) {
    const q = String(raw ?? '').trim();
    if (inFlight.current || q.length < 5 || q.length > 500 || !canInvestigate) return;
    inFlight.current = true;
    setError('');
    const id = retryOf ?? newTurnId();
    const startedAt = Date.now();
    setThread((t) => (retryOf
      ? t.map((x) => (x.id === id ? { ...x, status: 'pending', error: null, startedAt } : x))
      : [...t, { id, prompt: q, status: 'pending', startedAt }]));
    try {
      const res = await api('/api/investigate', {
        method: 'POST',
        body: JSON.stringify({ question: q }),
        signal: typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(REQUEST_TIMEOUT_MS) : undefined,
      });
      if (!res || typeof res.report !== 'object' || res.report === null) {
        throw new Error('The server returned no report.');
      }
      const entry = { ...makeEntry(q, res), ...(res.graph ? { graph: res.graph } : {}) };
      setHistory((h) => [entry, ...h].slice(0, MAX_HISTORY));
      setThread((t) => t.map((x) => (x.id === id ? { ...x, status: 'done', entry } : x)));
      setActiveId(entry.id);
      setOpenId(id);
    } catch (err) {
      const message = describeError(err);
      setThread((t) => t.map((x) => (x.id === id ? { ...x, status: 'error', error: message } : x)));
    } finally {
      inFlight.current = false;
    }
  }

  function submit(e) {
    e?.preventDefault();
    if (loading || question.trim().length < 5 || !canInvestigate) return;
    const q = question;
    setQuestion('');
    ask(q);
  }

  const onKeyDown = (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent?.isComposing) submit(e);
  };

  const healthText = !health ? 'Connecting\u2026'
    : health.status !== 'ok' ? 'Backend or FalkorDB unreachable'
    : health.nodes === undefined ? 'Backend reachable'
    : `Graph \u00b7 ${health.nodes} nodes${health.llmConfigured ? '' : ' \u00b7 graph-only mode'}`;

  // The same composer is shown centred on the landing page and docked at the bottom during a conversation.
  const renderComposer = (large) => (
    <>
      <form className={`composer${large ? ' lg' : ''}`} onSubmit={submit}>
        <textarea
          ref={inputRef}
          rows={large ? 2 : 1}
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          onKeyDown={onKeyDown}
          maxLength={500}
          disabled={!canInvestigate}
          aria-label="Investigation question"
          placeholder={canInvestigate ? 'Ask about a failure, dependency impact, or ownership\u2026' : 'Investigations are not available for this session'}
        />
        <div className="composer-actions">
          {/* Affordance only: voice input is not implemented yet, so the control is disabled and says so. */}
          <button type="button" className="mic" disabled aria-label="Voice input (not available yet)"
            title="Voice input is not available yet">
            <Icon name="mic" />
          </button>
          <button type="submit" className="send primary" aria-label="Send question"
            title={loading ? 'Waiting for the current investigation to finish' : 'Send'}
            disabled={loading || !canInvestigate || question.trim().length < 5}>
            <Icon name="send" />
          </button>
        </div>
      </form>
      <p className="composer-note muted">
        Enter to send &middot; Shift+Enter for a new line &middot; {question.length}/500. Each question is investigated on its own; follow-ups do not carry earlier context.
      </p>
    </>
  );

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

        <button type="button" className="new-btn" onClick={newInvestigation} disabled={loading}>
          <Icon name="plus" />New chat
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
                  <button type="button" className="hist-open" onClick={() => openEntry(h)} disabled={loading}
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
            <li className="side-empty">No investigations yet. Ask a question and it will appear here.</li>
          )}
        </ul>
        {storageNote && (
          <p className="side-note" role="status">{storageNote}</p>
        )}
      </aside>

      {/* ── Main workspace ────────────────────────────────────── */}
      <main className="main">
        <header className="topbar">
          <button type="button" className="menu-btn" aria-label="Open history" onClick={() => setNavOpen(true)}>
            <Icon name="menu" />
          </button>
          {active && (
            <div className="heading">
              <h1>{active.title}</h1>
              <p>{formatWhen(active.createdAt)} <ModeBadge entry={active} /></p>
            </div>
          )}
          <div className="topbar-actions">
            <span className={`pill status-pill ${health?.status === 'ok' ? 'ok' : health ? 'down' : ''}`} title={healthText}>
              <span className="pill-text">{healthText}</span>
            </span>
            <span className="user-chip" title={`Signed in as ${me.user.username} (${me.user.role})`}>
              <span className="avatar" aria-hidden="true">{me.user.username.slice(0, 1).toUpperCase()}</span>
              <span className="user-name">{me.user.username}</span>
              <span className="user-role">{me.user.role}</span>
            </span>
            <button type="button" className="signout" onClick={onSignOut}>Sign out</button>
          </div>
        </header>

        {roleNote && <div className="banner warn" role="status">{roleNote}</div>}

        {error && <div className="banner error" role="alert">{error}</div>}

        {/* Landing: product name, tagline, composer and a few one-tap starters */}
        {!thread.length && (
          <section className="hero" aria-label="Start a conversation">
            <h1>Synapse</h1>
            <p className="tagline">Understand what&rsquo;s happening across your systems.</p>
            <div className="hero-composer">{renderComposer(true)}</div>
            {canInvestigate && (
              <div className="starters" role="group" aria-label="Example questions">
                {STARTERS.map((s) => (
                  <button type="button" key={s.label} className="pill-btn" disabled={loading}
                    title={`${s.topic}: ${s.question}`} onClick={() => ask(s.question)}>{s.label}</button>
                ))}
              </div>
            )}
            <button type="button" className="link-btn graph-jump" onClick={jumpToGraph}>Explore the knowledge graph</button>
          </section>
        )}

        {/* Conversation */}
        {thread.length > 0 && (
          <section className="thread" aria-label="Conversation">
            {thread.map((t) => (
              <Turn key={t.id} turn={t} open={openId === t.id} multi={thread.length > 1} canAsk={canInvestigate && !loading}
                onToggle={() => setOpenId((cur) => (cur === t.id ? null : t.id))}
                onRetry={(turn) => ask(turn.prompt, turn.id)}
                onAsk={(q) => ask(q)} />
            ))}
          </section>
        )}

        <section className="card" id="knowledge-graph" aria-label="Knowledge graph visualisation">
          <h2>
            Knowledge graph
            <span className="tag">{active ? 'nodes cited as evidence are highlighted' : 'nodes and relationships'}</span>
          </h2>
          <GraphView nodes={graph.nodes} edges={graph.edges} highlight={highlight} />
        </section>

        {/* Conversation: composer pinned to the bottom of the workspace */}
        {thread.length > 0 && <div className="composer-dock">{renderComposer(false)}</div>}
      </main>
    </div>
  );
}

// Saved history lives in this browser; wiping it is part of ending a session.
const wipePersistedHistory = () => saveHistory([]);

export default function App() {
  const [me, setMe] = useState(undefined); // undefined = verifying, null = signed out, object = verified session
  const [notice, setNotice] = useState('');

  // Verify any stored token with the server BEFORE rendering anything protected.
  useEffect(() => {
    if (!getToken()) { setMe(null); return undefined; }
    let alive = true;
    api('/api/auth/me')
      .then((m) => {
        if (!alive) return;
        if (!m?.user?.id) throw new ApiError('The server returned an unexpected session response.', 0);
        adoptHistoryOwner(m.user.id, wipePersistedHistory);
        setMe(m);
      })
      .catch((e) => {
        if (!alive) return;
        if (e?.status === 401) {
          endSession(wipePersistedHistory);
          setNotice('Your session has expired. Please sign in again.');
        } else {
          setNotice(e?.message || 'Could not verify your session.');
        }
        setMe(null);
      });
    return () => { alive = false; };
  }, []);

  // POST /api/auth/login, then confirm the session with GET /api/auth/me; only then show the workspace.
  async function signIn(username, password) {
    clearToken();
    const res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) });
    if (typeof res?.token !== 'string' || !setToken(res.token)) {
      throw new ApiError('Signed in, but this browser could not keep the session. Check that site storage is enabled.', 0);
    }
    try {
      const m = await api('/api/auth/me');
      if (!m?.user?.id) throw new ApiError('The server returned an unexpected session response.', 0);
      adoptHistoryOwner(m.user.id, wipePersistedHistory);
      setNotice('');
      setMe(m);
    } catch (err) {
      clearToken();
      throw err;
    }
  }

  const signOut = () => { endSession(wipePersistedHistory); setNotice(''); setMe(null); };
  const authLost = () => {
    endSession(wipePersistedHistory);
    setNotice('Your session has expired or is no longer valid. Please sign in again.');
    setMe(null);
  };

  if (me === undefined) {
    return <main className="auth-screen"><p className="muted" role="status">Checking your session{'\u2026'}</p></main>;
  }
  if (me === null) return <Login onSignIn={signIn} notice={notice} />;
  return <Workspace key={me.user.id} me={me} onSignOut={signOut} onAuthLost={authLost} />;
}
