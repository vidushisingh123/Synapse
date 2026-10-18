// Readable rendering of one evidence record: { id, tool, input, data }.
// The record shape comes from the backend recorder (agent.js). `data` differs per
// graph tool, so this renders whatever fields were actually returned, generically,
// rather than assuming a fixed schema. Nothing here invents or rewrites values.

const MAX_DEPTH = 4; // also guards against runaway recursion on malformed data
const TITLE_KEYS = ['title', 'name'];

const TOOL_LABELS = {
  search_services: 'Service search',
  get_service_dependencies: 'Service dependencies',
  get_related_incidents: 'Related incidents',
  get_recent_deployments: 'Recent deployments',
  get_repositories: 'Repositories',
  get_engineers: 'Engineers',
  get_offboarding_risk: 'Offboarding risk',
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isEmpty = (v) => v === null || v === undefined || v === '';

// "rootCause" / "root_cause" -> "Root cause"; "id" -> "ID"
export function humanize(key) {
  const words = String(key)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase()
    .replace(/\bid\b/g, 'ID');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

export const toolLabel = (tool) => (typeof tool === 'string' && tool ? TOOL_LABELS[tool] ?? humanize(tool) : 'Unknown source');

// One-line, human-readable version of the tool input, e.g. "Engineer: Avery Chen"
export function describeInput(input) {
  if (!isObj(input) || !Object.keys(input).length) return 'No parameters';
  return Object.entries(input)
    .map(([k, v]) => {
      const shown = Array.isArray(v) ? v.map(String).join(', ') : isObj(v) ? '\u2026' : isEmpty(v) ? 'not set' : String(v);
      return `${humanize(k)}: ${shown}`;
    })
    .join('; ');
}

function Scalar({ v }) {
  if (isEmpty(v)) return <span className="ev-none">Not recorded</span>;
  if (typeof v === 'boolean') return <>{v ? 'Yes' : 'No'}</>;
  return <>{String(v)}</>;
}

function Value({ v, depth }) {
  if (Array.isArray(v)) {
    if (!v.length) return <span className="ev-none">None recorded</span>;
    if (v.every((x) => x === null || typeof x !== 'object')) {
      return <ul className="ev-tags">{v.map((x, i) => <li key={i}><Scalar v={x} /></li>)}</ul>;
    }
    if (depth >= MAX_DEPTH) return <span className="ev-none">{v.length} items (details omitted)</span>;
    return <div className="ev-records">{v.map((x, i) => <Record key={i} v={x} depth={depth + 1} />)}</div>;
  }
  if (isObj(v)) {
    if (!Object.keys(v).length) return <span className="ev-none">None recorded</span>;
    if (depth >= MAX_DEPTH) return <span className="ev-none">Nested details omitted</span>;
    return <Record v={v} depth={depth + 1} />;
  }
  return <Scalar v={v} />;
}

function Fields({ entries, depth }) {
  return (
    <dl className="ev-fields">
      {entries.map(([k, v]) => (
        <div className="ev-field" key={k}>
          <dt>{humanize(k)}</dt>
          <dd><Value v={v} depth={depth} /></dd>
        </div>
      ))}
    </dl>
  );
}

function Record({ v, depth }) {
  if (!isObj(v)) return <div className="ev-record"><Value v={v} depth={depth} /></div>;
  const titleKey = TITLE_KEYS.find((k) => typeof v[k] === 'string' && v[k]);
  const rest = Object.entries(v).filter(([k]) => k !== titleKey);
  return (
    <div className="ev-record">
      {titleKey && <div className="ev-rec-title">{v[titleKey]}</div>}
      {rest.length > 0 && <Fields entries={rest} depth={depth} />}
    </div>
  );
}

export function EvidenceBody({ data }) {
  if (isEmpty(data)) return <p className="ev-none">No data was recorded for this evidence.</p>;
  if (!isObj(data)) return <Value v={data} depth={1} />;
  const entries = Object.entries(data);
  if (!entries.length) return <p className="ev-none">No data was recorded for this evidence.</p>;
  const simple = entries.filter(([, v]) => v === null || typeof v !== 'object');
  const nested = entries.filter(([, v]) => v !== null && typeof v === 'object');
  return (
    <div className="ev-data">
      {simple.length > 0 && <Fields entries={simple} depth={1} />}
      {nested.map(([k, v]) => (
        <section className="ev-section" key={k}>
          <h4>
            {humanize(k)}
            {Array.isArray(v) && <span className="ev-count">{v.length}</span>}
          </h4>
          <Value v={v} depth={1} />
        </section>
      ))}
    </div>
  );
}

// One collapsible evidence entry. The element id (ev-<id>) is what citations jump to.
export default function EvidenceItem({ ev }) {
  const tool = typeof ev.tool === 'string' ? ev.tool : '';
  return (
    <details id={`ev-${ev.id}`}>
      <summary>
        <strong className="ev-id">{String(ev.id)}</strong>
        <span className="ev-tool">{toolLabel(ev.tool)}</span>
        <span className="ev-input">{describeInput(ev.input)}</span>
      </summary>
      <div className="ev-body">
        <p className="ev-source">
          Source: graph query{tool && <> <code>{tool}</code></>}
        </p>
        <EvidenceBody data={ev.data} />
      </div>
    </details>
  );
}
