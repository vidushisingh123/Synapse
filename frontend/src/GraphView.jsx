const COLUMNS = ['Engineer', 'Repository', 'Service', 'Incident', 'Deployment'];
const W = 900;
const NODE_W = 140;
const NODE_H = 28;

export default function GraphView({ nodes, edges, highlight }) {
  if (!nodes.length) return <p className="muted">No graph data loaded.</p>;

  const cols = COLUMNS.filter((c) => nodes.some((n) => n.label === c));
  const byCol = Object.fromEntries(cols.map((c) => [c, nodes.filter((n) => n.label === c)]));
  const H = Math.max(260, Math.max(...cols.map((c) => byCol[c].length)) * 48 + 40);

  const pos = {};
  cols.forEach((c, ci) => {
    const x = ((ci + 0.5) * W) / cols.length;
    byCol[c].forEach((n, i) => {
      pos[n.id] = { x, y: ((i + 1) * H) / (byCol[c].length + 1) };
    });
  });

  const edgePath = (a, b) => {
    if (Math.abs(a.x - b.x) < 1) {
      return `M ${a.x} ${a.y} Q ${a.x + 110} ${(a.y + b.y) / 2} ${b.x} ${b.y}`;
    }
    return `M ${a.x} ${a.y} L ${b.x} ${b.y}`;
  };

  return (
    <div className="graph-scroll">
      <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 640, width: '100%' }} role="img" aria-label="Knowledge graph">
        {edges.map((e, i) => {
          const a = pos[e.source];
          const b = pos[e.target];
          if (!a || !b) return null;
          const hot = highlight.has(e.source) && highlight.has(e.target);
          return (
            <path key={i} d={edgePath(a, b)} fill="none"
              stroke={hot ? '#4f9cff' : '#2b3441'} strokeWidth={hot ? 2 : 1} opacity={hot ? 0.9 : 0.6}>
              <title>{e.type}</title>
            </path>
          );
        })}
        {nodes.map((n) => {
          const p = pos[n.id];
          const hot = highlight.has(n.id);
          const label = n.name.length > 19 ? `${n.name.slice(0, 18)}…` : n.name;
          return (
            <g key={n.id} opacity={hot ? 1 : 0.45}>
              <rect x={p.x - NODE_W / 2} y={p.y - NODE_H / 2} width={NODE_W} height={NODE_H} rx={14}
                fill="#161b22" stroke={`var(--c-${n.label})`} strokeWidth={hot ? 2.5 : 1.2} />
              <text x={p.x} y={p.y + 4} textAnchor="middle" fontSize="12" fill="#e6edf3">{label}</text>
              <title>{`${n.label}: ${n.name}`}</title>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {cols.map((c) => (
          <span key={c}><i className="dot" style={{ background: `var(--c-${c})` }} />{c}</span>
        ))}
      </div>
    </div>
  );
}