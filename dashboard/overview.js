'use strict';

// =============================================================================
// Overview (T-305) — modular per-project landing page, Server-Driven UI.
//
// The layout is data, not code: `overview.json` in the project directory
// describes which widgets render where on a 12-column grid. Agents edit it
// through the same API humans use (PUT /api/projects/:name/overview) — the
// trusted registry below is the only set of types the renderer will accept.
// Design reference: context/claude-design-t305 (Claude Design handoff).
// =============================================================================

const fs = require('fs');
const path = require('path');

// --- Trusted widget catalog (server-side mirror of the frontend registry) ---
// `defaultSize` guides agents and the add-widget picker; `props` documents
// the accepted per-widget options.
const WIDGET_TYPES = {
  'active-agents': {
    label: 'Active Agents',
    description: 'Who is working on what right now — claims, lease countdown, activity pulse.',
    defaultSize: { w: 8, h: 3 },
    minSize: { w: 3, h: 1 },
    props: { maxRows: 'number (optional) — cap the number of agent rows' },
  },
  'task-stats': {
    label: 'Task Stats',
    description: 'Status distribution, throughput (done/7d), average cycle time, stuck hint.',
    defaultSize: { w: 7, h: 2 },
    minSize: { w: 3, h: 1 },
    props: {},
  },
  'next-up': {
    label: 'Next Up',
    description: 'Top open/backlog tasks by priority.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { limit: 'number (optional, default 5)' },
  },
  'recent-decisions': {
    label: 'Recent Decisions',
    description: 'Latest entries from DECISIONS.md (markdown stays source of truth).',
    defaultSize: { w: 5, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { count: 'number (optional, default 3)' },
  },
  'project-goals': {
    label: 'Project Goal',
    description: 'Goal/scope excerpt from PROJECT.md.',
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 2, h: 1 },
    props: {},
  },
  'quick-links': {
    label: 'Quick Actions',
    description: 'Create a task, an idea note or a context file in one click.',
    defaultSize: { w: 4, h: 1 },
    minSize: { w: 2, h: 1 },
    props: { tiles: 'boolean (optional) — 2x2 tile form for h>=2' },
  },
  'kanban-mini': {
    label: 'Board Preview',
    description: 'Compact kanban preview, opens the full board.',
    defaultSize: { w: 12, h: 2 },
    minSize: { w: 6, h: 2 },
    props: {},
  },
  'current-focus': {
    label: 'Current Focus',
    description: 'The claimed tasks, prominent: who is on what, since when, lease state.',
    defaultSize: { w: 7, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { maxRows: 'number (optional, default 4)' },
  },
  'blocked': {
    label: 'Blocked',
    description: 'Needs you: tasks flagged as blocked, waiting for a human decision.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { limit: 'number (optional, default 6)' },
  },
  'approvals': {
    label: 'Approvals',
    description: 'Needs you: tasks in review, waiting for your sign-off.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { limit: 'number (optional, default 6)' },
  },
  'since-last-visit': {
    label: 'Since your last visit',
    description: 'What moved while you were away — status changes, checkpoints, comments.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { limit: 'number (optional, default 8)' },
  },
  'activity-stream': {
    label: 'Activity',
    description: 'Latest task events across the project.',
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 1 },
    props: { limit: 'number (optional, default 12)' },
  },
  'milestones': {
    label: 'Milestones',
    description: 'Milestones as definition-of-done checklists — create and manage them in the widget (milestone:<name> tags).',
    defaultSize: { w: 6, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { focus: 'string (optional) — pinned focus milestone' },
  },
  'file-viewer': {
    label: 'File Viewer',
    description: 'Renders one project file (markdown) right on the overview — pick it in the widget (props.path).',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    props: { path: "string (optional) — project-relative file, e.g. 'context/NOTES.md'" },
  },
  'timeline': {
    label: 'Timeline',
    description: 'Dated spine over all project activity (tasks, checkpoints, comments).',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 2, h: 2 },
    props: { limit: 'number (optional, default 25)' },
  },
  'context-index': {
    label: 'Context Index',
    description: 'Files in context/ — the knowledge agents read first. Pin via props.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { pins: 'string[] (optional) — filenames starred on top', limit: 'number (optional, default 8)' },
  },
  'quick-drop': {
    label: 'Quick Drop',
    description: 'Drop markdown/text files — they land in context/.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 1 },
    props: {},
  },
  'notes': {
    label: 'Notes',
    description: 'Scratchpad persisted as context/NOTES.md — agents can read and append.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 2, h: 2 },
    props: {},
  },
  'links': {
    label: 'Links',
    description: 'Pinned external links (deploys, docs, dashboards) from props.links.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 2, h: 1 },
    props: { links: 'array of { label, url }', limit: 'number (optional, default 6)' },
  },
  'repo-status': {
    label: 'Repo Status',
    description: 'GitHub at a glance — default branch, CI state, open PRs, latest commits. Opt-in via props.repo.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)" },
  },
  'agent-questions': {
    label: 'Agent Questions',
    description: 'Open questions from agents, answerable inline — comments with kind "question", an answer resolves them.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { limit: 'number (optional, default 20)' },
  },
  'gh-pulls': {
    label: 'Pull Requests',
    description: 'PR inbox — ready vs draft, requested reviews first. Opt-in via props.repo.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)" },
  },
  'gh-ci': {
    label: 'CI Runs',
    description: 'Workflow run history as a duration trend with pass rate. Opt-in via props.repo (+ props.branch).',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)", branch: 'string (optional, defaults to the default branch)' },
  },
  'gh-releases': {
    label: 'Releases',
    description: 'Latest release and what is unreleased since. Opt-in via props.repo.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)" },
  },
  'gh-issues': {
    label: 'Issues',
    description: 'Issue triage — new, unanswered, age distribution. Opt-in via props.repo.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)" },
  },
  'stall-detection': {
    label: 'Momentum',
    description: 'Friendly stall check — last activity, 14-day strip.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: {},
  },
};

// --- Named presets (the three Claude Design variants). The agent picks one
// at project setup — or composes a fully custom layout from the catalog. ---
const PRESETS = {
  default: {
    label: 'Standard',
    description: 'Re-orientation with momentum, timeline and knowledge at hand — modeled on a real daily-driver layout (T-327).',
    widgets: [
      { id: 'w-stall', type: 'stall-detection', grid: { x: 0, y: 0, w: 6, h: 3 } },
      { id: 'w-timeline', type: 'timeline', grid: { x: 6, y: 0, w: 3, h: 5 } },
      { id: 'w-drop', type: 'quick-drop', grid: { x: 9, y: 0, w: 3, h: 2 } },
      { id: 'w-context', type: 'context-index', grid: { x: 9, y: 2, w: 3, h: 3 } },
      { id: 'w-milestones', type: 'milestones', grid: { x: 0, y: 3, w: 3, h: 2 } },
      { id: 'w-quick', type: 'quick-links', grid: { x: 3, y: 3, w: 3, h: 2 } },
      { id: 'w-agents', type: 'active-agents', grid: { x: 0, y: 5, w: 5, h: 2 } },
      { id: 'w-notes', type: 'notes', grid: { x: 5, y: 5, w: 4, h: 2 } },
      { id: 'w-links', type: 'links', grid: { x: 9, y: 5, w: 3, h: 2 } },
      { id: 'w-stats', type: 'task-stats', grid: { x: 0, y: 7, w: 12, h: 2 } },
    ],
  },
  coding: {
    label: 'Coding',
    description: 'Repo-first: GitHub status, CI and PRs on top, focus and board below — for projects living in a repository.',
    widgets: [
      { id: 'w-repo', type: 'repo-status', grid: { x: 0, y: 0, w: 5, h: 2 } },
      { id: 'w-ci', type: 'gh-ci', grid: { x: 5, y: 0, w: 4, h: 2 } },
      { id: 'w-pulls', type: 'gh-pulls', grid: { x: 9, y: 0, w: 3, h: 2 } },
      { id: 'w-focus', type: 'current-focus', grid: { x: 0, y: 2, w: 5, h: 2 } },
      { id: 'w-blocked', type: 'blocked', grid: { x: 5, y: 2, w: 4, h: 2 } },
      { id: 'w-approvals', type: 'approvals', grid: { x: 9, y: 2, w: 3, h: 2 } },
      { id: 'w-releases', type: 'gh-releases', grid: { x: 0, y: 4, w: 4, h: 2 } },
      { id: 'w-issues', type: 'gh-issues', grid: { x: 4, y: 4, w: 4, h: 2 } },
      { id: 'w-milestones', type: 'milestones', grid: { x: 8, y: 4, w: 4, h: 2 } },
      { id: 'w-board', type: 'kanban-mini', grid: { x: 0, y: 6, w: 12, h: 2 } },
    ],
  },
  knowledge: {
    label: 'Knowledge',
    description: 'Document-first: a large file viewer with the context index, notes and quick capture — for projects that are mostly thinking, not tasks.',
    widgets: [
      { id: 'w-file', type: 'file-viewer', grid: { x: 0, y: 0, w: 6, h: 4 } },
      { id: 'w-context', type: 'context-index', grid: { x: 6, y: 0, w: 3, h: 2 } },
      { id: 'w-drop', type: 'quick-drop', grid: { x: 9, y: 0, w: 3, h: 2 } },
      { id: 'w-notes', type: 'notes', grid: { x: 6, y: 2, w: 6, h: 3 } },
      { id: 'w-goals', type: 'project-goals', grid: { x: 0, y: 4, w: 6, h: 1 } },
      { id: 'w-decisions', type: 'recent-decisions', grid: { x: 0, y: 5, w: 6, h: 2 } },
      { id: 'w-links', type: 'links', grid: { x: 6, y: 5, w: 3, h: 2 } },
      { id: 'w-quick', type: 'quick-links', grid: { x: 9, y: 5, w: 3, h: 2 } },
    ],
  },
  mission: {
    label: 'Mission Control',
    description: 'The review desk: what needs you first (emphasized), then focus, milestones, stats and agents — for steering many parallel agents.',
    widgets: [
      { id: 'w-blocked', type: 'blocked', props: { emphasis: true }, grid: { x: 0, y: 0, w: 4, h: 2 } },
      { id: 'w-approvals', type: 'approvals', props: { emphasis: true }, grid: { x: 4, y: 0, w: 4, h: 2 } },
      { id: 'w-since', type: 'since-last-visit', grid: { x: 8, y: 0, w: 4, h: 2 } },
      { id: 'w-focus', type: 'current-focus', grid: { x: 0, y: 2, w: 6, h: 2 } },
      { id: 'w-milestones', type: 'milestones', grid: { x: 6, y: 2, w: 6, h: 2 } },
      { id: 'w-stats', type: 'task-stats', grid: { x: 0, y: 4, w: 8, h: 2 } },
      { id: 'w-stall', type: 'stall-detection', grid: { x: 8, y: 4, w: 4, h: 2 } },
      { id: 'w-agents', type: 'active-agents', grid: { x: 0, y: 6, w: 8, h: 2 } },
      { id: 'w-quick', type: 'quick-links', grid: { x: 8, y: 6, w: 4, h: 1 } },
      { id: 'w-links', type: 'links', grid: { x: 8, y: 7, w: 4, h: 1 } },
    ],
  },
};

const DEFAULT_PRESET = 'default';
const MAX_WIDGETS = 40;
const MAX_PROPS_BYTES = 2048;
const GRID_COLUMNS = 12;

// Coarse size hints for the coordinate-free flow authoring path: a width in
// columns. Height comes from the widget's defaultSize. An unrecognized hint is
// ignored (the widget keeps its natural defaultSize width).
const FLOW_SIZE_WIDTH = { s: 3, m: 6, l: 8, full: GRID_COLUMNS };
const FLOW_FALLBACK_SIZE = { w: 4, h: 2 };

function overviewPath(projectsDir, projectName) {
  return path.join(projectsDir, projectName, 'overview.json');
}

function presetConfig(name) {
  const preset = PRESETS[name];
  if (!preset) return null;
  return {
    version: 1,
    layout: 'grid',
    preset: name,
    widgets: preset.widgets.map(w => ({ ...w, grid: { ...w.grid }, ...(w.props ? { props: { ...w.props } } : {}) })),
  };
}

/**
 * Expand a coordinate-free, ordered widget list into a 12-column grid config.
 * Each item is { type, size?, props?, title?, id? } — `size` is a coarse hint
 * ('s'|'m'|'l'|'full', case-insensitive); height comes from the widget's
 * defaultSize. Widgets flow left-to-right and wrap to the next row when they
 * would overflow the 12 columns (shelf packing), so layouts never overlap.
 *
 * Unknown widget types are packed with a neutral fallback size and left for
 * validateOverview to reject — flow authoring stays a thin layer over the one
 * trusted validator. Returns a grid config { version, layout:'grid', widgets }.
 */
function packFlow(items) {
  const list = Array.isArray(items) ? items : [];
  const usedIds = new Set();
  let cursorX = 0;
  let rowY = 0;
  let rowMaxH = 0;
  const widgets = list.map((item, i) => {
    const it = item && typeof item === 'object' ? item : {};
    const def = WIDGET_TYPES[it.type];
    const base = def ? def.defaultSize : FLOW_FALLBACK_SIZE;
    const min = def ? def.minSize : { w: 1, h: 1 };
    let w = base.w;
    if (typeof it.size === 'string') {
      const mapped = FLOW_SIZE_WIDTH[it.size.toLowerCase()];
      if (Number.isInteger(mapped)) w = mapped;
    }
    w = Math.max(min.w, Math.min(GRID_COLUMNS, w));
    const h = Math.max(min.h, Math.min(12, base.h));
    if (cursorX + w > GRID_COLUMNS) {
      rowY += rowMaxH;
      cursorX = 0;
      rowMaxH = 0;
    }
    const grid = { x: cursorX, y: rowY, w, h };
    cursorX += w;
    rowMaxH = Math.max(rowMaxH, h);
    let id = typeof it.id === 'string' && it.id ? it.id : `w-${i}`;
    while (usedIds.has(id)) id = `${id}-${i}`;
    usedIds.add(id);
    return {
      id,
      type: it.type,
      ...(typeof it.title === 'string' ? { title: it.title } : {}),
      ...(it.props && typeof it.props === 'object' && !Array.isArray(it.props) ? { props: it.props } : {}),
      grid,
    };
  });
  return { version: 1, layout: 'grid', widgets };
}

/**
 * Validate an overview config against the trusted registry.
 * Returns { ok: true, config } with a normalized copy, or { ok: false, errors }.
 */
function validateOverview(input) {
  const errors = [];
  if (!input || typeof input !== 'object') return { ok: false, errors: ['config must be an object'] };
  if (input.version !== 1) errors.push('version must be 1');
  if (input.layout !== undefined && input.layout !== 'grid') errors.push('layout must be "grid"');
  if (!Array.isArray(input.widgets)) {
    errors.push('widgets must be an array');
    return { ok: false, errors };
  }
  if (input.widgets.length > MAX_WIDGETS) errors.push(`too many widgets (max ${MAX_WIDGETS})`);

  const ids = new Set();
  const widgets = [];
  input.widgets.forEach((w, i) => {
    const at = `widgets[${i}]`;
    if (!w || typeof w !== 'object') { errors.push(`${at} must be an object`); return; }
    if (typeof w.id !== 'string' || !/^[\w-]{1,64}$/.test(w.id)) errors.push(`${at}.id must be a short [word/-] string`);
    else if (ids.has(w.id)) errors.push(`${at}.id "${w.id}" is duplicated`);
    else ids.add(w.id);
    if (!WIDGET_TYPES[w.type]) errors.push(`${at}.type "${w.type}" is not a registered widget`);
    if (w.title !== undefined && (typeof w.title !== 'string' || w.title.length > 64)) errors.push(`${at}.title must be a string (max 64 chars)`);
    const g = w.grid;
    if (!g || typeof g !== 'object') errors.push(`${at}.grid is required ({x,y,w,h})`);
    else {
      for (const k of ['x', 'y', 'w', 'h']) {
        if (!Number.isInteger(g[k])) errors.push(`${at}.grid.${k} must be an integer`);
      }
      if (Number.isInteger(g.x) && (g.x < 0 || g.x > 11)) errors.push(`${at}.grid.x must be 0..11`);
      if (Number.isInteger(g.y) && (g.y < 0 || g.y > 99)) errors.push(`${at}.grid.y must be 0..99`);
      if (Number.isInteger(g.w) && (g.w < 1 || g.w > 12)) errors.push(`${at}.grid.w must be 1..12`);
      if (Number.isInteger(g.h) && (g.h < 1 || g.h > 12)) errors.push(`${at}.grid.h must be 1..12`);
      if (Number.isInteger(g.x) && Number.isInteger(g.w) && g.x + g.w > 12) errors.push(`${at}.grid x+w exceeds 12 columns`);
    }
    if (w.props !== undefined) {
      if (!w.props || typeof w.props !== 'object' || Array.isArray(w.props)) errors.push(`${at}.props must be an object`);
      else if (Buffer.byteLength(JSON.stringify(w.props), 'utf8') > MAX_PROPS_BYTES) errors.push(`${at}.props too large (max ${MAX_PROPS_BYTES} bytes)`);
    }
    widgets.push({
      id: w.id,
      type: w.type,
      ...(w.title !== undefined ? { title: w.title } : {}),
      ...(w.props !== undefined ? { props: w.props } : {}),
      grid: { x: g?.x, y: g?.y, w: g?.w, h: g?.h },
    });
  });

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    config: {
      version: 1,
      layout: 'grid',
      ...(typeof input.preset === 'string' && PRESETS[input.preset] ? { preset: input.preset } : {}),
      widgets,
    },
  };
}

function readOverview(projectsDir, projectName) {
  const file = overviewPath(projectsDir, projectName);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    const result = validateOverview(raw);
    // A stored file that no longer validates (e.g. widget removed from the
    // registry) degrades gracefully: invalid entries are reported, the
    // default still renders.
    if (result.ok) return { source: 'file', ...result.config };
    console.warn(`[overview] invalid overview.json in ${projectName}:`, result.errors.join('; '));
    return { source: 'default', invalid: result.errors, ...presetConfig(DEFAULT_PRESET) };
  } catch {
    return { source: 'default', ...presetConfig(DEFAULT_PRESET) };
  }
}

function writeOverview(projectsDir, projectName, config) {
  const file = overviewPath(projectsDir, projectName);
  fs.writeFileSync(file, JSON.stringify(config, null, 2) + '\n');
}

function widgetManifest() {
  return {
    gridColumns: 12,
    rowHeight: 88,
    gutter: 12,
    widgets: Object.entries(WIDGET_TYPES).map(([type, def]) => ({ type, ...def })),
    presets: Object.entries(PRESETS).map(([name, p]) => ({ name, label: p.label, description: p.description, widgets: presetConfig(name).widgets })),
  };
}

module.exports = {
  WIDGET_TYPES,
  PRESETS,
  DEFAULT_PRESET,
  validateOverview,
  packFlow,
  presetConfig,
  readOverview,
  writeOverview,
  widgetManifest,
};
