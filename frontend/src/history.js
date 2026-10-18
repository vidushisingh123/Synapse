// Investigation history persisted in localStorage. Every function is safe if storage is
// unavailable, full, or contains malformed data.
const KEY = 'synapse.history.v1';
export const MAX_HISTORY = 50;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/** Short readable title from the prompt: first sentence, trimmed to 60 characters. */
export function makeTitle(prompt) {
  const flat = String(prompt ?? '').replace(/\s+/g, ' ').trim();
  if (!flat) return 'Untitled investigation';
  const first = flat.split(/(?<=[.?!])\s/)[0].replace(/[.?!]+$/, '').trim() || flat;
  return first.length > 60 ? `${first.slice(0, 59).trimEnd()}…` : first;
}

export function newId() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Build a history entry from the existing /api/investigate response. Nothing is invented. */
export function makeEntry(prompt, res) {
  return {
    id: newId(),
    prompt,
    title: makeTitle(prompt),
    createdAt: new Date().toISOString(),
    mode: res.mode ?? null,
    model: res.model ?? null,
    warning: res.warning ?? null,
    report: res.report,
    evidence: Array.isArray(res.evidence) ? res.evidence : [],
  };
}

const isValid = (e) =>
  isObject(e) && typeof e.id === 'string' && typeof e.prompt === 'string' && isObject(e.report);

export function loadHistory() {
  try {
    const raw = globalThis.localStorage?.getItem(KEY);
    if (!raw) return [];
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    const byId = new Map();
    for (const e of data) {
      if (isValid(e) && !byId.has(e.id)) {
        byId.set(e.id, {
          ...e,
          title: typeof e.title === 'string' && e.title ? e.title : makeTitle(e.prompt),
          evidence: Array.isArray(e.evidence) ? e.evidence : [],
        });
      }
    }
    return [...byId.values()].slice(0, MAX_HISTORY);
  } catch {
    return [];
  }
}

/** Returns true if saved. On quota errors, keeps the newest half and retries. */
export function saveHistory(list) {
  let items = list;
  for (;;) {
    try {
      globalThis.localStorage.setItem(KEY, JSON.stringify(items));
      return true;
    } catch {
      if (items.length <= 1) return false;
      items = items.slice(0, Math.ceil(items.length / 2));
    }
  }
}

export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}