'use strict';

/**
 * Lazy-load registry for PROJECT-RULES sections.
 *
 * Each endpoint name maps to a markdown file under docs/project-mode/.
 * Some endpoint names alias existing docs (e.g. "api-access" → "tasks-api.md") to
 * avoid duplication. BOOTSTRAP.md embeds only the manifest; agents request detail
 * sections on demand via GET /api/projects/:name/rules/:section.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const OPENCLAW_HOME = process.env.OPENCLAW_HOME || path.join(os.homedir(), '.openclaw');
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || path.join(OPENCLAW_HOME, 'projects');
const WORKSPACE_PROJECTS_DIR = path.join(OPENCLAW_HOME, 'workspace', 'projects');
const PROJECTS_DIR = fs.existsSync(SHARED_PROJECTS_DIR) ? SHARED_PROJECTS_DIR : WORKSPACE_PROJECTS_DIR;
const RULES_DIR = path.resolve(__dirname, '..', 'docs', 'project-mode');

const SECTIONS = [
  { name: 'commands',        file: 'commands.md',         label: 'Project commands (activate, deactivate, list)' },
  { name: 'api-access',      file: 'tasks-api.md',        label: 'Task API — endpoints, task model, lifecycle' },
  { name: 'hzl',             file: 'hzl.md',              label: 'HZL backend — event store, lease semantics, multi-agent state' },
  { name: 'canvas',          file: 'canvas-and-notes.md', label: 'Canvas — ideas, spatial notes, promote-to-task' },
  { name: 'files',           file: 'project-files.md',    label: 'Project file roles — PROJECT.md, SESSIONS.md, context/, specs/' },
  { name: 'specify',         file: 'specify-workflow.md', label: 'Specify workflow — spec generation lifecycle' },
  { name: 'agent-bridge',    file: 'agent-bridge.md',     label: 'Agent bridge — claim/checkpoint/complete, handoff, multi-agent' },
  { name: 'compliance',      file: 'compliance.md',       label: 'Compliance — stuck/stale + routed-unclaimed detection, health metrics' },
  { name: 'error-handling',  file: 'error-handling.md',   label: 'Error handling — missing files, inconsistency resolution, migration leftovers' },
  { name: 'key-principles',  file: 'key-principles.md',   label: 'Key principles — API-first, DB-canonical, context-loading semantics' },
  { name: 'overview',        file: 'overview.md',         label: 'Overview — modular landing page, widget catalog, layout API' },
];

const BY_NAME = new Map(SECTIONS.map(s => [s.name, s]));

function listRuleSections() {
  return SECTIONS.map(({ name, label }) => ({ name, label }));
}

function resolveRuleSectionPath(name) {
  if (typeof name !== 'string' || name.length === 0) return null;
  const entry = BY_NAME.get(name);
  if (!entry) return null;
  const full = path.join(RULES_DIR, entry.file);
  const normalized = path.resolve(full);
  if (!normalized.startsWith(RULES_DIR + path.sep) && normalized !== RULES_DIR) return null;
  return normalized;
}

function readRuleSection(name) {
  const p = resolveRuleSectionPath(name);
  if (!p) return null;
  try {
    return fs.readFileSync(p, 'utf8');
  } catch {
    return null;
  }
}

function resolveProjectRoot(projectName) {
  if (typeof projectName !== 'string' || projectName.trim().length === 0) return null;
  const root = path.resolve(PROJECTS_DIR);
  const projectRoot = path.resolve(root, projectName);
  if (!projectRoot.startsWith(root + path.sep) && projectRoot !== root) return null;
  return projectRoot;
}

function readProjectDocument(projectName) {
  const projectRoot = resolveProjectRoot(projectName);
  if (!projectRoot) return null;
  const projectMd = path.join(projectRoot, 'PROJECT.md');
  try {
    const content = fs.readFileSync(projectMd, 'utf8');
    return content.trim().length > 0 ? content : null;
  } catch {
    return null;
  }
}

function buildRulesManifest() {
  const lines = [];
  lines.push('## Project Rules (lazy-load)');
  lines.push('');
  lines.push('Rule sections are served on demand. Request content via:');
  lines.push('`GET /api/projects/{project}/rules/{section}` — returns markdown.');
  lines.push('');
  lines.push('Available sections:');
  for (const { name, label } of SECTIONS) {
    lines.push(`- \`${name}\` — ${label}`);
  }
  lines.push('');
  // T-296: action→section mapping. The contract is "soft" by design (no
  // enforcement middleware), so it must at least tell the agent which section
  // to read before which action — otherwise an agent proceeds on stale
  // assumptions (e.g. writing a spec file by hand instead of via the API).
  lines.push('When to load what — read the section BEFORE the action:');
  lines.push('- Before creating, claiming, or transitioning tasks → `api-access`.');
  lines.push('- Before composing or editing a project overview layout → `overview`.');
  lines.push('- Before creating or editing specs, or writing ANY file under the project dir → `files` and `specify`. **Spec files are never written by hand — always use `POST /api/projects/{project}/specs/{taskId}`.**');
  lines.push('- Before canvas / promote operations → `canvas`.');
  lines.push('- On any API error or when blocked → `error-handling`.');
  lines.push('- For activate/deactivate/list project commands → `commands`.');
  lines.push('');
  lines.push('Legacy reference: the old monolithic ruleset is archived in the source repo only, outside the install artifact. Prefer the lazy-load sections above for targeted context.');
  return lines.join('\n');
}

// T-296: structured rules pointer for the /status activation responses, so an
// external agent that activates a project (and never fetches a per-task
// handoff) still learns the /rules endpoint exists and what to load when.
function buildRulesPointer(projectName) {
  const p = projectName || '{project}';
  return {
    manifestUrl: `/api/projects/${p}/rules`,
    sectionUrlTemplate: `/api/projects/${p}/rules/{section}`,
    sections: listRuleSections(),
    directive: 'Load the rule section relevant to your next action before acting: '
      + '`api-access` before creating/claiming/transitioning tasks; '
      + '`files` + `specify` before creating or editing specs or writing any project file '
      + '(spec files are never written by hand — use POST /api/projects/' + p + '/specs/{taskId}); '
      + '`canvas` before promote; `error-handling` on any API error.',
  };
}

function getBootstrapReadiness(projectName) {
  if (typeof projectName !== 'string' || projectName.length === 0) {
    return { contextReady: false, missingSections: ['PROJECT.md', ...SECTIONS.map(s => s.name)] };
  }

  const missingSections = [];
  if (!readProjectDocument(projectName)) {
    missingSections.push('PROJECT.md');
  }
  for (const { name } of SECTIONS) {
    const content = readRuleSection(name);
    if (typeof content !== 'string' || content.trim().length === 0) {
      missingSections.push(name);
    }
  }

  return {
    contextReady: missingSections.length === 0,
    missingSections,
  };
}

function buildOperationalTaskStateMarkdown(tasks, options = {}) {
  const blocker = options.blocker || null;
  if (blocker) {
    return [
      '## Operational Task State',
      '',
      `**BLOCKER:** ${blocker}`,
      'Do not infer current work, claims, review state, or next tasks from `PROJECT.md`, `SESSIONS.md`, conversation history, or memory.',
      '',
    ].join('\n');
  }

  // T-230: soft, non-alarming degradation for a *transient* API miss (e.g. a
  // brief KeepAlive restart window). Unlike `blocker`, this does not frame the
  // situation as a hard failure to be "solved" — the hard-blocker framing used
  // to nudge agents into improvising `find PROJECT.md` over the projects
  // symlink. It tells the agent to retry the API and explicitly NOT to scan
  // files for task or project state.
  const transient = options.transient || null;
  if (transient) {
    return [
      '## Operational Task State',
      '',
      `**Live task state temporarily unavailable** (\`${transient.url}\`: ${transient.reason}).`,
      'This is almost always a brief restart window of the local FlowBoard service — not a missing project. Retry the Tasks API in a moment: `GET /api/projects/<project>/tasks`.',
      'Do **not** fall back to scanning files for task or project state — do not `find`/grep `PROJECT.md`, `SESSIONS.md`, `tasks.json`, or the `~/.openclaw/projects` tree (that path is a symlink and is never authoritative for current work).',
      '',
    ].join('\n');
  }

  if (!Array.isArray(tasks)) {
    return [
      '## Operational Task State',
      '',
      '**BLOCKER:** Live task state is unavailable.',
      'Do not infer current work, claims, review state, or next tasks from `PROJECT.md`, `SESSIONS.md`, conversation history, or memory.',
      '',
    ].join('\n');
  }

  if (!tasks.length) {
    return [
      '## Operational Task State',
      '',
      '**Task counts:** no tasks',
      '',
      '**Reminder:** The FlowBoard Tasks API is the only source of truth for operational task state.',
      'Do not infer current work, claims, review state, or next tasks from `PROJECT.md`, `SESSIONS.md`, conversation history, or memory.',
      '',
    ].join('\n');
  }

  const topLevel = tasks.filter(t => !t.parentId && !t.trashedAt && t.status !== 'archived');
  const backlog = topLevel.filter(t => t.status === 'backlog');
  const open = topLevel.filter(t => t.status === 'open');
  const inProgress = topLevel.filter(t => t.status === 'in-progress');
  const review = topLevel.filter(t => t.status === 'review');
  const blocked = topLevel.filter(t => t.blocked === true);

  const countParts = [];
  if (backlog.length) countParts.push(`Backlog: ${backlog.length}`);
  if (open.length) countParts.push(`Open: ${open.length}`);
  if (inProgress.length) {
    const bCount = inProgress.filter(t => t.blocked).length;
    countParts.push(`In Progress: ${inProgress.length}${bCount ? ` (${bCount} blocked)` : ''}`);
  }
  if (review.length) {
    const bCount = review.filter(t => t.blocked).length;
    countParts.push(`Review: ${review.length}${bCount ? ` (${bCount} blocked)` : ''}`);
  }
  if (blocked.length) countParts.push(`Blocked: ${blocked.length}`);

  const lines = ['## Operational Task State', ''];
  if (countParts.length) lines.push(`**Task counts:** ${countParts.join(' | ')}`);
  lines.push('');

  if (inProgress.length) {
    lines.push('**In Progress:**');
    for (const t of inProgress) {
      const blockedTag = t.blocked ? ' BLOCKED' : '';
      lines.push(`- ${t.id}: ${t.title}${blockedTag}${t.specFile ? ` (spec: ${t.specFile})` : ''}`);
    }
  }
  if (review.length) {
    lines.push('**Waiting for Review:**');
    for (const t of review) {
      const blockedTag = t.blocked ? ' BLOCKED' : '';
      lines.push(`- ${t.id}: ${t.title}${blockedTag}`);
    }
  }
  if (blocked.length && !inProgress.length && !review.length) {
    lines.push(`**Blocked tasks:** ${blocked.map(t => `${t.id} (${t.status})`).join(', ')}`);
  }
  if (!inProgress.length && !review.length) {
    const available = [...open, ...backlog].slice(0, 7);
    lines.push(`**No task in-progress.** ${open.length + backlog.length} available top-level task(s) from the live API.`);
    if (available.length) {
      lines.push('**Available next tasks:**');
      for (const t of available) {
        lines.push(`- ${t.id} [${t.priority || 'medium'} / ${t.status}]: ${t.title}${t.specFile ? ` (spec: ${t.specFile})` : ''}`);
      }
    }
  }

  lines.push('');
  lines.push('**Reminder:** The FlowBoard Tasks API is the only source of truth for operational task state.');
  lines.push('Always set a task to `in-progress` before starting work. Set to `review` when done. Never infer current work, claims, review state, or next tasks from project Markdown.');

  return lines.join('\n');
}

function buildBootstrapDocument(projectName, options = {}) {
  const readiness = getBootstrapReadiness(projectName);
  if (!readiness.contextReady) {
    const err = new Error('Project context is not ready');
    err.code = 'CONTEXT_NOT_READY';
    err.project = projectName || null;
    err.missingSections = readiness.missingSections;
    throw err;
  }

  const projectDocument = readProjectDocument(projectName);

  const lines = [];
  lines.push(`# Active Project: ${projectName}\n`);
  lines.push(buildOperationalTaskStateMarkdown(options.tasks, {
    blocker: options.taskStateBlocker,
  }));
  lines.push(`\n## Project Knowledge: ${projectName}\n`);
  lines.push('The following `PROJECT.md` content is stable project knowledge only.');
  lines.push('It is not authoritative for current task focus, claims, review state, or next work; use the `Operational Task State` section above and the Tasks API for that.\n');
  lines.push(projectDocument);

  // T-296: include the rules manifest (pointer + action→section mapping) so
  // an agent learns the /rules endpoint exists and which section to consult
  // for which action. The full sections are still embedded below as an escape
  // hatch for agents that cannot make on-demand /rules calls (see
  // docs/concepts/lazy-loading.md; ADR-0005 amendment).
  lines.push(`\n---\n`);
  lines.push(buildRulesManifest());

  // Embed all rule sections directly into the bootstrap document
  for (const { name, label } of SECTIONS) {
    const content = readRuleSection(name);
    if (content) {
      lines.push(`\n---\n`);
      if (label) lines.push(`## ${label}\n`);
      lines.push(content);
    }
  }

  const document = lines.join('\n');
  if (document.trim().length === 0) {
    const err = new Error('Project context rendered empty');
    err.code = 'CONTEXT_EMPTY';
    err.project = projectName || null;
    throw err;
  }
  return document;
}

module.exports = {
  RULES_DIR,
  PROJECTS_DIR,
  SECTIONS,
  listRuleSections,
  resolveRuleSectionPath,
  readRuleSection,
  resolveProjectRoot,
  readProjectDocument,
  buildOperationalTaskStateMarkdown,
  buildRulesManifest,
  buildRulesPointer,
  getBootstrapReadiness,
  buildBootstrapDocument,
};
