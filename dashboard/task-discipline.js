'use strict';

const VALUES = Object.freeze(['list', 'standard', 'development']);
const DEFAULT = 'list';

function normalize(value) {
  return VALUES.includes(value) ? value : DEFAULT;
}

function suggest(signals = {}) {
  if (signals.github && typeof signals.github.repo === 'string' && signals.github.repo.trim()) return 'development';
  const text = [signals.name, signals.displayName, signals.description, signals.group]
    .filter(v => typeof v === 'string').join(' ').toLowerCase();
  if (/\b(repo|repository|code|coding|backend|frontend|api|service|server|library|sdk|cli|build|deploy|development|software)\b/.test(text)) return 'development';
  if (/\b(docs?|documentation|wiki|notes?|research|knowledge|handbook|writing|content|book|article|blog|journal|orchestrat\w*|coordinat\w*|mission|ops|operations|fleet|swarm|multi-agent|agents?)\b/.test(text)) return 'standard';
  return DEFAULT;
}

// T-464: `missing_spec_link` used to fire here for any `development` task
// without a spec. Measured 2026-08-26: 16 of 16 structureReview flags across
// two projects carried this one reason, and the other reasons below — the
// ones that describe observable form — never fired once. "Does this task
// need a spec?" is a judgment about scope and future work that the server
// cannot see; ADR-0035's line is that FlowBoard enforces only what it can
// see, which is form. The spec is still recommended (see rules-api.js's
// `api-access` note for `development`) — it is just no longer marked.
//
// `flat_batch` is gone for the same reason. It fired on `batchSize > 1` or
// `siblingBatch`, but the only caller that ever set either was the batch
// endpoint's own `{parent, subtasks}` branch — the correct mechanism for
// keeping related tasks together. A well-formed batch create flagged its
// parent and every subtask with advice to do exactly what the call just
// did. The shape it claimed to catch — several separate top-level creates —
// is invisible to the server (each is a separate HTTP request) and
// structurally impossible through this endpoint anyway, since it rejects
// any item that sets `parentId`. What remains, `missing_description` and
// `title_pattern`, is derivable from `title`/`description` alone.
function reasonsFor({ discipline, title, description } = {}) {
  const mode = normalize(discipline);
  if (mode === DEFAULT) return [];
  const reasons = [];
  if (mode !== DEFAULT && (!description || !String(description).trim())) reasons.push('missing_description');
  if (mode !== 'list' && typeof title === 'string' && /^(fix|update|change|do|task|work on)\b/i.test(title.trim()) && title.trim().length < 24) reasons.push('title_pattern');
  return [...new Set(reasons)];
}

function review(reasons) {
  return reasons.length ? { status: 'pending', reviewer: null, reviewedAt: null, reasons } : null;
}

module.exports = { VALUES, DEFAULT, normalize, suggest, reasonsFor, review };
