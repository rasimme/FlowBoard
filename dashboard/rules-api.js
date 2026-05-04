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
  { name: 'error-handling',  file: 'error-handling.md',   label: 'Error handling — missing files, corrupt state, migration leftovers' },
  { name: 'key-principles',  file: 'key-principles.md',   label: 'Key principles — API-first, DB-canonical, context-loading semantics' },
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
  lines.push('Legacy reference: the full monolithic ruleset is archived at `docs/project-mode/legacy/PROJECT-RULES.md` in the FlowBoard repo. Prefer the lazy-load sections above for targeted context.');
  return lines.join('\n');
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

function buildBootstrapDocument(projectName) {
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
  lines.push(`## Project: ${projectName}\n`);
  lines.push(projectDocument);

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
  buildRulesManifest,
  getBootstrapReadiness,
  buildBootstrapDocument,
};
