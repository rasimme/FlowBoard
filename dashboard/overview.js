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
    minSize: { w: 4, h: 2 },
    props: { maxRows: 'number (optional) — cap the number of agent rows' },
  },
  'task-stats': {
    label: 'Task Stats',
    description: 'Status distribution, throughput (done/7d), average cycle time, stuck hint.',
    defaultSize: { w: 7, h: 2 },
    minSize: { w: 4, h: 2 },
    props: {},
  },
  'next-up': {
    label: 'Next Up',
    description: 'Top open/backlog tasks by priority.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 5)' },
  },
  'recent-decisions': {
    label: 'Recent Decisions',
    description: 'Latest entries from DECISIONS.md (markdown stays source of truth).',
    defaultSize: { w: 5, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { count: 'number (optional, default 3)' },
  },
  'project-goals': {
    label: 'Project Goal',
    description: 'Goal/scope excerpt from PROJECT.md.',
    defaultSize: { w: 8, h: 2 },
    minSize: { w: 4, h: 2 },
    props: {},
  },
  'quick-links': {
    label: 'Quick Actions',
    description: 'Create a task, an idea note or a context file in one click.',
    defaultSize: { w: 4, h: 1 },
    minSize: { w: 3, h: 1 },
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
    minSize: { w: 4, h: 2 },
    props: { maxRows: 'number (optional, default 4)' },
  },
  'blocked': {
    label: 'Blocked',
    description: 'Needs you: tasks flagged as blocked, waiting for a human decision.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 6)' },
  },
  'approvals': {
    label: 'Approvals',
    description: 'Needs you: tasks in review, waiting for your sign-off.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 6)' },
  },
  'since-last-visit': {
    label: 'Since your last visit',
    description: 'What moved while you were away — status changes, checkpoints, comments.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 8)' },
  },
  'activity-stream': {
    label: 'Activity',
    description: 'Latest task events across the project.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 12)' },
  },
  'milestones': {
    label: 'Milestones',
    description: 'Progress per milestone — tag tasks with milestone:<name>.',
    defaultSize: { w: 6, h: 2 },
    minSize: { w: 3, h: 2 },
    props: {},
  },
  'timeline': {
    label: 'Timeline',
    description: 'Dated spine over all project activity (tasks, checkpoints, comments).',
    defaultSize: { w: 4, h: 3 },
    minSize: { w: 3, h: 2 },
    props: { limit: 'number (optional, default 25)' },
  },
  'context-index': {
    label: 'Context Index',
    description: 'Files in context/ — the knowledge agents read first. Pin via props.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: { pins: 'string[] (optional) — filenames starred on top', limit: 'number (optional, default 8)' },
  },
  'quick-drop': {
    label: 'Quick Drop',
    description: 'Drop markdown/text files — they land in context/.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: {},
  },
  'notes': {
    label: 'Notes',
    description: 'Scratchpad persisted as context/NOTES.md — agents can read and append.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: {},
  },
  'links': {
    label: 'Links',
    description: 'Pinned external links (deploys, docs, dashboards) from props.links.',
    defaultSize: { w: 3, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { links: 'array of { label, url }', limit: 'number (optional, default 6)' },
  },
  'repo-status': {
    label: 'Repo Status',
    description: 'GitHub at a glance — default branch, CI state, open PRs, latest commits. Opt-in via props.repo.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 1 },
    props: { repo: "string 'owner/name' (required)" },
  },
  'stall-detection': {
    label: 'Momentum',
    description: 'Friendly stall check — last activity, 14-day strip.',
    defaultSize: { w: 4, h: 2 },
    minSize: { w: 3, h: 2 },
    props: {},
  },
};

// --- Named presets (the three Claude Design variants). The agent picks one
// at project setup — or composes a fully custom layout from the catalog. ---
const PRESETS = {
  default: {
    label: 'Re-orientation (default)',
    description: 'Concept decision E: what needs you first (blocked, approvals, since-last-visit), then current focus and next-up, then agents, goal and quick actions.',
    widgets: [
      { id: 'w-blocked', type: 'blocked', grid: { x: 0, y: 0, w: 4, h: 2 } },
      { id: 'w-approvals', type: 'approvals', grid: { x: 4, y: 0, w: 4, h: 2 } },
      { id: 'w-since', type: 'since-last-visit', grid: { x: 8, y: 0, w: 4, h: 2 } },
      { id: 'w-focus', type: 'current-focus', grid: { x: 0, y: 2, w: 7, h: 2 } },
      { id: 'w-nextup', type: 'next-up', grid: { x: 7, y: 2, w: 5, h: 2 } },
      { id: 'w-agents', type: 'active-agents', grid: { x: 0, y: 4, w: 8, h: 2 } },
      { id: 'w-goals', type: 'project-goals', grid: { x: 8, y: 4, w: 4, h: 2 } },
      { id: 'w-links', type: 'quick-links', grid: { x: 8, y: 6, w: 4, h: 1 } },
    ],
  },
  agent: {
    label: 'Agent-centric',
    description: 'Daily work with running agents: active-agents hero, quick actions and priorities on the right, stats + decisions below.',
    widgets: [
      { id: 'w-agents', type: 'active-agents', grid: { x: 0, y: 0, w: 8, h: 3 } },
      { id: 'w-links', type: 'quick-links', grid: { x: 8, y: 0, w: 4, h: 1 } },
      { id: 'w-nextup', type: 'next-up', grid: { x: 8, y: 1, w: 4, h: 2 } },
      { id: 'w-stats', type: 'task-stats', grid: { x: 0, y: 3, w: 7, h: 2 } },
      { id: 'w-decisions', type: 'recent-decisions', grid: { x: 7, y: 3, w: 5, h: 2 } },
    ],
  },
  status: {
    label: 'Status-centric',
    description: 'Reviews and stand-ups: stats first, full-width board preview, operations as three columns.',
    widgets: [
      { id: 'w-stats', type: 'task-stats', grid: { x: 0, y: 0, w: 8, h: 2 } },
      { id: 'w-links', type: 'quick-links', props: { tiles: true }, grid: { x: 8, y: 0, w: 4, h: 2 } },
      { id: 'w-board', type: 'kanban-mini', grid: { x: 0, y: 2, w: 12, h: 2 } },
      { id: 'w-agents', type: 'active-agents', props: { maxRows: 3 }, grid: { x: 0, y: 4, w: 4, h: 2 } },
      { id: 'w-nextup', type: 'next-up', grid: { x: 4, y: 4, w: 4, h: 2 } },
      { id: 'w-decisions', type: 'recent-decisions', props: { count: 2 }, grid: { x: 8, y: 4, w: 4, h: 2 } },
    ],
  },
  context: {
    label: 'Context-centric',
    description: 'Documentation-heavy projects and re-entry after a break: PROJECT.md and DECISIONS.md dominant.',
    widgets: [
      { id: 'w-goals', type: 'project-goals', grid: { x: 0, y: 0, w: 8, h: 2 } },
      { id: 'w-agents', type: 'active-agents', props: { maxRows: 3 }, grid: { x: 8, y: 0, w: 4, h: 2 } },
      { id: 'w-decisions', type: 'recent-decisions', props: { count: 4 }, grid: { x: 0, y: 2, w: 8, h: 3 } },
      { id: 'w-stats', type: 'task-stats', grid: { x: 8, y: 2, w: 4, h: 2 } },
      { id: 'w-links', type: 'quick-links', grid: { x: 8, y: 4, w: 4, h: 1 } },
    ],
  },
};

const DEFAULT_PRESET = 'default';
const MAX_WIDGETS = 24;
const MAX_PROPS_BYTES = 2048;

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
  presetConfig,
  readOverview,
  writeOverview,
  widgetManifest,
};
