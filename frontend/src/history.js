// Investigation history: this browser's copy of the answers the signed-in account received, kept in
// localStorage so it survives a refresh and a closed tab. The server stores no investigation history.
//
// Ownership: the saved list is wrapped with the id of the account it belongs to. That id is the one auth.js
// recorded after the session was verified (adoptHistoryOwner). Saving is refused when no owner is recorded,
// and loading returns nothing unless the saved owner is the current owner, so one account's investigations
// are never handed to another, even if a wipe did not happen. Sign-out, an expired session and a change of
// account wipe the data (auth.js endSession / adoptHistoryOwner call saveHistory([])).
//
// Honesty: readHistory() and saveHistoryDetailed() report what really happened (unreadable data, skipped
// entries, only some entries fitting, nothing saved) so the UI never claims a save that did not occur.
//
// Limits: localStorage is per browser profile and plain text, readable by anyone who can open this browser
// and by any script on this origin; the quota is about 5 MB; two tabs saving at once is last write wins.
import { historyOwner } from './auth.js';

const KEY = 'synapse.history.v2';
const LEGACY_KEY = 'synapse.history.v1'; // list written before history had an owner: never loaded, always wiped
const INTERIM_PREFIX = 'synapse.history.v2.'; // per-user keys from an interim version: wiped too
export const MAX_HISTORY = 50;

const NOT_SAVED = 'History could not be saved in this browser; it will be lost on refresh.';
const NOT_READ = 'Saved history could not be read from this browser, so it was not loaded.';
const NOT_CLEARED = 'Saved history could not be removed from this browser.';
const onlySome = (kept, wanted) =>
  `Only the ${kept} newest of ${wanted} investigations fit in this browser\u2019s storage; older ones will be missing after a refresh.`;
const skippedMsg = (n) =>
  `${n} saved investigation${n === 1 ? '' : 's'} could not be read and ${n === 1 ? 'was' : 'were'} skipped.`;

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const local = () => { try { return globalThis.localStorage ?? null; } catch { return null; } };
const session = () => { try { return globalThis.sessionStorage ?? null; } catch { return null; } };
const isQuota = (e) => Boolean(e) && (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED' || e.code === 22 || e.code === 1014);

function removeFrom(storage) {
  if (!storage) return true;
  try {
    const stale = [];
    for (let i = 0; i < storage.length; i++) {
      const k = storage.key(i);
      if (k === KEY || k === LEGACY_KEY || (k && k.startsWith(INTERIM_PREFIX))) stale.push(k);
    }
    stale.forEach((k) => storage.removeItem(k)); // removing never needs free quota, so a wipe cannot fail for lack of space
    return true;
  } catch {
    return false;
  }
}

/** Remove every saved investigation (this account's and any unowned/legacy copy). The owner marker is auth.js's. */
export function clearHistory() {
  const a = removeFrom(local());
  const b = removeFrom(session());
  return a && b;
}

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

/**
 * Read this account's saved investigations. Returns { entries, problem }: `problem` is null, or a
 * user-facing sentence when saved data could not be read or some entries had to be skipped.
 * Another account's data (or data with no owner) is neither returned nor reported.
 */
export function readHistory() {
  const storage = local();
  if (!storage) return { entries: [], problem: NOT_READ };
  let raw;
  try {
    raw = storage.getItem(KEY);
  } catch {
    return { entries: [], problem: NOT_READ };
  }
  if (raw === null || raw === undefined) return { entries: [], problem: null };

  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { entries: [], problem: NOT_READ };
  }
  if (!isObject(data) || !Array.isArray(data.entries) || typeof data.owner !== 'string') {
    return { entries: [], problem: NOT_READ };
  }
  const owner = historyOwner();
  if (!owner || data.owner !== owner) return { entries: [], problem: null };

  const byId = new Map();
  let skipped = 0;
  for (const e of data.entries) {
    if (!isValid(e)) skipped++;
    else if (!byId.has(e.id)) {
      byId.set(e.id, {
        ...e,
        title: typeof e.title === 'string' && e.title ? e.title : makeTitle(e.prompt),
        evidence: Array.isArray(e.evidence) ? e.evidence : [],
      });
    }
  }
  return { entries: [...byId.values()].slice(0, MAX_HISTORY), problem: skipped ? skippedMsg(skipped) : null };
}

/**
 * Save the list (newest first). Returns { ok, saved, total, problem }; `ok` is true only when every
 * entry is now stored. If the quota is hit, the newest entries that fit are kept and `problem` says so.
 * An empty list wipes the saved history.
 */
export function saveHistoryDetailed(list) {
  const wanted = (Array.isArray(list) ? list : []).slice(0, MAX_HISTORY);
  if (wanted.length === 0) {
    const ok = clearHistory();
    return { ok, saved: 0, total: 0, problem: ok ? null : NOT_CLEARED };
  }
  const storage = local();
  const owner = historyOwner();
  if (!storage || !owner) return { ok: false, saved: 0, total: wanted.length, problem: NOT_SAVED };

  for (let keep = wanted.length; keep >= 1; keep--) {
    const payload = JSON.stringify({ v: 2, owner, entries: wanted.slice(0, keep) });
    try {
      storage.setItem(KEY, payload);
      if (storage.getItem(KEY) !== payload) continue; // accepted but not kept: never report that as saved
      const all = keep === wanted.length;
      return { ok: all, saved: keep, total: wanted.length, problem: all ? null : onlySome(keep, wanted.length) };
    } catch (e) {
      if (!isQuota(e)) break; // storage is blocked, not full: fewer entries will not help
    }
  }
  return { ok: false, saved: 0, total: wanted.length, problem: NOT_SAVED };
}

/** Boolean form: true only if the whole list was saved. */
export function saveHistory(list) {
  return saveHistoryDetailed(list).ok;
}

/** This account's saved investigations (see readHistory for the reason when it is empty). */
export function loadHistory() {
  return readHistory().entries;
}

export function formatWhen(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });
}
