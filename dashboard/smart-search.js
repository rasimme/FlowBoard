'use strict';

/**
 * T-369 — Smart search for tasks (dashboard-only, in-memory).
 *
 * Two pure pieces, both unit-tested without a DB or server:
 *   - parseQuery(raw)  → extracts filter operators + detects a task-id query
 *   - rankTasks(tasks, raw, opts) → filters + fuzzy/infix matches + ranks
 *
 * The FTS5 index in hzl-core is intentionally untouched; this layer works
 * over the in-memory task cache (see hzlService.smartSearchTasks).
 */

const OPERATOR_RE = /^(status|project|agent|is|has):(.+)$/i;
const STATUS_ALIASES = { wip: 'in-progress', in_progress: 'in-progress' };
const ID_RE = /^t?-?(\d+(?:-\d+)?)$/i;

/**
 * Parse a raw search string into { text, idQuery, filters }.
 * Unknown `key:value` tokens are left in the free text.
 */
function parseQuery(raw) {
  const filters = { status: [], project: null, agent: null, is: [], hasSpec: false };
  const textTokens = [];

  for (const token of String(raw || '').trim().split(/\s+/).filter(Boolean)) {
    const m = token.match(OPERATOR_RE);
    if (!m) { textTokens.push(token); continue; }
    const key = m[1].toLowerCase();
    const value = m[2];
    if (key === 'status') {
      const v = value.toLowerCase();
      filters.status.push(STATUS_ALIASES[v] || v);
    } else if (key === 'project') {
      filters.project = value; // resolved to canonical name by the caller
    } else if (key === 'agent') {
      const v = value.toLowerCase();
      filters.agent = (v === 'none' || v === 'unclaimed') ? 'none' : v;
    } else if (key === 'is') {
      filters.is.push(value.toLowerCase());
    } else if (key === 'has') {
      if (value.toLowerCase() === 'spec') filters.hasSpec = true;
    }
  }

  const text = textTokens.join(' ');
  let idQuery = null;
  const idm = text.match(ID_RE);
  if (idm) idQuery = normId(idm[1]);

  return { text, idQuery, filters };
}

/**
 * Normalize a task-id (or the numeric tail of one) to a leading-zero-insensitive
 * comparison key: `T-<n>[-<n>...]`. So `007`, `T-007`, `7` all → `T-7`, matching
 * how FlowBoard zero-pads ids (`T-013`). Subtask ids keep their suffix (`T-42-1`).
 */
function normId(s) {
  const digits = String(s).replace(/^[tT]-?/, '');
  if (!/^\d+(?:-\d+)?$/.test(digits)) return null;
  return 'T-' + digits.split('-').map(n => String(parseInt(n, 10))).join('-');
}

// --- ranking weights --------------------------------------------------------

const STATUS_WEIGHT = { 'in-progress': 4, review: 3, open: 2, backlog: 2, done: 1, archived: 0 };
const PRIORITY_WEIGHT = { high: 3, medium: 2, low: 1 };

/** Bounded Levenshtein: returns a value > max as soon as it is exceeded. */
function boundedLev(a, b, max) {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + cost);
      if (cur[j] < rowMin) rowMin = cur[j];
    }
    if (rowMin > max) return max + 1; // early exit — whole row already over budget
    prev = cur;
  }
  return prev[b.length];
}

const words = (s) => String(s || '').toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);

/** Score one query token against one field string. 0 = no match. */
function fieldScore(field, qt, weight) {
  if (!field) return 0;
  if (field === qt) return weight * 3;
  const ws = words(field);
  if (ws.includes(qt)) return weight * 2.5;
  if (ws.some(w => w.startsWith(qt))) return weight * 2;
  if (field.includes(qt)) return weight * 1.2; // infix (mid-word)
  const thr = qt.length <= 5 ? 1 : 2;
  if (qt.length >= 3 && ws.some(w => boundedLev(w, qt, thr) <= thr)) return weight * 0.8; // fuzzy
  return 0;
}

function bestTokenScore(qt, f) {
  return Math.max(
    fieldScore(f.title, qt, 100),
    fieldScore(f.tags, qt, 60),
    fieldScore(f.desc, qt, 25),
  );
}

/** Apply the hard operator filters from a parsed query. */
function passesFilters(task, filters) {
  if (filters.status.length && !filters.status.includes(task.status)) return false;
  if (filters.project && String(task.project || '').toLowerCase() !== filters.project.toLowerCase()) return false;
  if (filters.agent) {
    if (filters.agent === 'none') { if (task.agent) return false; }
    else {
      const a = String(task.agent || '').toLowerCase();
      const r = String(task.routedAgent || '').toLowerCase();
      if (a !== filters.agent && r !== filters.agent) return false;
    }
  }
  if (filters.hasSpec && !task.specFile) return false;
  for (const facet of filters.is) {
    if (facet === 'blocked' && task.blocked !== true) return false;
    if (facet === 'claimed' && !task.agent) return false;
    if (facet === 'unclaimed' && task.agent) return false;
    if (facet === 'done' && task.status !== 'done') return false;
    if (facet === 'stale' && task._stale !== true) return false;
  }
  return true;
}

/**
 * Filter + match + rank tasks for a raw query.
 * Returns new objects `{ ...task, _score, exact }`, best first. Pure: no I/O.
 * The caller applies any limit and precomputes `_stale` for `is:stale`.
 */
function rankTasks(tasks, raw, opts = {}) {
  const parsed = opts.parsed || parseQuery(raw);
  const text = parsed.text.toLowerCase().trim();
  const idMode = Boolean(parsed.idQuery);
  const qTokens = idMode ? [] : text.split(/\s+/).filter(Boolean);
  const out = [];

  for (const task of tasks) {
    if (!passesFilters(task, parsed.filters)) continue;

    let score = 0;
    let exact = false;

    if (idMode) {
      const id = normId(task.id);
      const q = parsed.idQuery;
      if (id === q) { score = 1000; exact = true; }
      else if (id && id.startsWith(q)) { score = 300; }
      else continue; // id query → only id matches survive
    } else if (qTokens.length) {
      const f = {
        title: String(task.title || '').toLowerCase(),
        tags: (task.tags || []).join(' ').toLowerCase(),
        desc: String(task.description || '').toLowerCase(),
      };
      let total = 0;
      let allMatched = true;
      for (const qt of qTokens) {
        const s = bestTokenScore(qt, f);
        if (s === 0) { allMatched = false; break; } // AND: every token must match somewhere
        total += s;
      }
      if (!allMatched) continue;
      if (f.title === text) total += 500;            // whole-query exact title
      else if (f.title.startsWith(text)) total += 200; // whole-query title prefix
      score = total;
    }
    // else: operator-only query → score stays 0, task is included

    out.push({ ...task, _score: score, exact });
  }

  out.sort((a, b) => {
    if (b._score !== a._score) return b._score - a._score;
    const sw = (STATUS_WEIGHT[b.status] ?? 2) - (STATUS_WEIGHT[a.status] ?? 2);
    if (sw) return sw;
    const rc = String(b.created || '').localeCompare(String(a.created || ''));
    if (rc) return rc;
    return (PRIORITY_WEIGHT[b.priority] ?? 2) - (PRIORITY_WEIGHT[a.priority] ?? 2);
  });

  return out;
}

module.exports = { parseQuery, rankTasks };
