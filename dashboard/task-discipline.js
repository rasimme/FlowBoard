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

function reasonsFor({ discipline, title, description, specFile, batchSize = 1, siblingBatch = false } = {}) {
  const mode = normalize(discipline);
  if (mode === DEFAULT) return [];
  const reasons = [];
  if (mode === 'development' && (batchSize > 1 || siblingBatch)) reasons.push('flat_batch');
  if (mode !== DEFAULT && (!description || !String(description).trim())) reasons.push('missing_description');
  if (mode !== 'list' && typeof title === 'string' && /^(fix|update|change|do|task|work on)\b/i.test(title.trim()) && title.trim().length < 24) reasons.push('title_pattern');
  if (mode === 'development' && !specFile) reasons.push('missing_spec_link');
  return [...new Set(reasons)];
}

function review(reasons) {
  return reasons.length ? { status: 'pending', reviewer: null, reviewedAt: null, reasons } : null;
}

module.exports = { VALUES, DEFAULT, normalize, suggest, reasonsFor, review };
