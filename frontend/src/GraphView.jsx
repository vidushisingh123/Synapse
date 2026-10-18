const COLUMNS = ['Engineer', 'Repository', 'Service', 'Incident', 'Deployment'];
const W = 1000;
const NODE_W = 148;
const NODE_H = 30;
const HEAD = 30; // room for column headings

// Each entity type has its own marker shape as well as its own colour,
// so the graph stays readable without relying on colour alone.
const SHAPES = { Service: 'circle', Repository: 'square', Engineer: 'diamond', Incident: 'triangle', Deployment: 'hexagon' };

function Marker({ type, cx = 0, cy = 0, r = 4.5 }) {
  const pts = (arr) => arr.map(([x, y]) => `${cx + x},${cy + y}`).join(' ');
  switch (SHAPES[type]) {
    case 'square':
      return <rect className="g-mark" x={cx - r} y={cy - r} width={r * 2} height={r * 2} rx={1} />;
    case 'diamond':
      return <polygon className="g-mark" points={pts([[0, -r * 1.3], [r * 1.3, 0], [0, r * 1.3], [-r * 1.3, 0]])} />;
    case 'triangle':
      return <polygon className="g-mark" points={pts([[0, -r * 1.25], [r * 1.2, r * 0.95], [-r * 1.2, r * 0.95]])} />;
    case 'hexagon':
      return (
        <polygon className="g-mark"
          points={pts([0, 1, 2, 3, 4, 5].map((i) => [r * 1.15 * Math.cos((Math.PI / 3) * i), r * 1.15 * Math.sin((Math.PI / 3) * i)]))} />
      );
    default:
      return <circle className="g-mark" cx={cx} cy={cy} r={r} />;
  }
}

export default function GraphView({ nodes, edges, highlight }) {
  if (!nodes.length) return <p className="muted graph-empty">No graph data loaded.</p>;

  const cols = COLUMNS.filter((c) => nodes.some((n) => n.label === c));
  const byCol = Object.fromEntries(cols.map((c) => [c, nodes.filter((n) => n.label === c)]));
  const bodyH = Math.max(240, Math.max(...cols.map((c) => byCol[c].length)) * 46 + 40);
  const H = bodyH + HEAD;

  const pos = {};
  cols.forEach((c, ci) => {
    const x = ((ci + 0.5) * W) / cols.length;
    byCol[c].forEach((n, i) => {
      pos[n.id] = { x, y: HEAD + ((i + 1) * bodyH) / (byCol[c].length + 1) };
    });
  });

  const edgePath = (a, b) => {
    if (Math.abs(a.x - b.x) < 1) {
      const sx = a.x + NODE_W / 2;
      return `M ${sx} ${a.y} C ${sx + 56} ${a.y}, ${sx + 56} ${b.y}, ${sx} ${b.y}`;
    }
    const dir = b.x > a.x ? 1 : -1;
    const x1 = a.x + (dir * NODE_W) / 2;
    const x2 = b.x - (dir * NODE_W) / 2;
    const mx = (x1 + x2) / 2;
    return `M ${x1} ${a.y} C ${mx} ${a.y}, ${mx} ${b.y}, ${x2} ${b.y}`;
  };

  // With no investigation open there is nothing to emphasise, so nothing is dimmed.
  const dimOthers = highlight.size > 0;

  const drawn = edges
    .map((e, i) => {
      const a = pos[e.source];
      const b = pos[e.target];
      if (!a || !b) return null;
      return { e, i, a, b, hot: highlight.has(e.source) && highlight.has(e.target) };
    })
    .filter(Boolean)
    .sort((x, y) => Number(x.hot) - Number(y.hot)); // highlighted edges paint last

  return (
    <div className="graph-wrap on-dark">
      <div className="graph-scroll">
        <svg viewBox={`0 0 ${W} ${H}`} style={{ minWidth: 760, width: '100%' }} role="img" aria-label="Knowledge graph">
          {cols.map((c, ci) => (
            <text key={c} className="g-col" x={((ci + 0.5) * W) / cols.length} y={16} textAnchor="middle">{c}</text>
          ))}
          {drawn.map(({ e, i, a, b, hot }) => (
            <path key={i} d={edgePath(a, b)} fill="none" className={`g-edge${hot ? ' hot' : dimOthers ? ' dim' : ''}`}>
              <title>{e.type}</title>
            </path>
          ))}
          {nodes.map((n) => {
            const p = pos[n.id];
            const hot = highlight.has(n.id);
            const label = n.name.length > 22 ? `${n.name.slice(0, 21)}\u2026` : n.name;
            return (
              <g key={n.id} className={`g-node${hot ? ' hot' : dimOthers ? ' dim' : ''}`} style={{ '--node': `var(--c-${n.label})` }}>
                <rect x={p.x - NODE_W / 2} y={p.y - NODE_H / 2} width={NODE_W} height={NODE_H} rx={8} />
                <Marker type={n.label} cx={p.x - NODE_W / 2 + 13} cy={p.y} />
                <text x={p.x - NODE_W / 2 + 25} y={p.y + 4}>{label}</text>
                <title>{`${n.label}: ${n.name}`}</title>
              </g>
            );
          })}
        </svg>
      </div>
      <div className="legend">
        {cols.map((c) => (
          <span key={c} style={{ '--node': `var(--c-${c})` }}>
            <svg viewBox="-8 -8 16 16" aria-hidden="true"><Marker type={c} /></svg>
            {c}
          </span>
        ))}
      </div>
    </div>
  );
}
