#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';

const API = process.env.FLOWBOARD_API || 'http://127.0.0.1:18790';
const PROJECT = 'flowboard-v5-demo';
const AGENTS = ['release-lead', 'design-agent', 'content-agent', 'qa-agent'];
const SUPPORT_PROJECTS = [
  ['flowboard-demo-core', 'Core Platform', 'Launcher platform infrastructure.', 'Launch Program', false, 10],
  ['flowboard-demo-brand', 'Brand System', 'Design system and brand assets.', 'Launch Program', false, 20],
  ['flowboard-demo-content', 'Content Studio', 'Editorial workflow for launch copy.', 'Launch Program', false, 30],
  [PROJECT, 'Website Launch Demo', 'Reusable public fixture for FlowBoard v5 screenshots.', 'Launch Program', false, 40],
  ['flowboard-demo-archive', 'Archived Sprint', 'Completed launch spike kept as archive example.', null, true, 90],
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

async function request(path, options = {}) {
  const res = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  const data = text ? JSON.parse(text) : null;
  if (!res.ok) {
    const message = data?.error || text || `HTTP ${res.status}`;
    throw new Error(`${options.method || 'GET'} ${path}: ${message}`);
  }
  return data;
}

async function projectExists(name) {
  const data = await request('/api/projects');
  return (data.projects || []).some((project) => project.name === name);
}

async function ensureProject({ name, displayName, description, group = null, archived = false, order = null }) {
  if (!(await projectExists(name))) {
    await request('/api/projects', {
      method: 'POST',
      body: JSON.stringify({ name, displayName, description, group }),
    });
  }
  await request(`/api/projects/${name}`, {
    method: 'PUT',
    body: JSON.stringify({ displayName, group, archived, order }),
  });
}

async function clearProjectTasks(project) {
  const data = await request(`/api/projects/${project}/tasks`);
  const tasks = data.tasks || [];
  const parents = tasks.filter((task) => !task.parentId);
  const children = tasks.filter((task) => task.parentId);

  for (const task of parents) {
    await request(`/api/projects/${project}/tasks/${task.id}?mode=all`, { method: 'DELETE' }).catch(() => null);
  }
  for (const task of children) {
    await request(`/api/projects/${project}/tasks/${task.id}`, { method: 'DELETE' }).catch(() => null);
  }
  await request(`/api/projects/${project}/tasks/trash`, { method: 'DELETE' }).catch(() => null);
}

async function createTask({ title, priority = 'medium', status = 'backlog', parentId = null }) {
  const data = await request(`/api/projects/${PROJECT}/tasks`, {
    method: 'POST',
    body: JSON.stringify({ title, priority, status, parentId }),
  });
  return data.task;
}

async function updateTask(id, patch) {
  const data = await request(`/api/projects/${PROJECT}/tasks/${id}`, {
    method: 'PUT',
    body: JSON.stringify(patch),
  });
  return data.task;
}

async function claimTask(id, agent, message, progress = 40) {
  await request(`/api/status`, {
    method: 'PUT',
    body: JSON.stringify({ agentId: agent, project: PROJECT }),
  });
  const data = await request(`/api/projects/${PROJECT}/tasks/${id}/claim`, {
    method: 'POST',
    body: JSON.stringify({ agent, lease: 24 * 60 }),
  });
  if (message) {
    await request(`/api/projects/${PROJECT}/tasks/${id}/checkpoint`, {
      method: 'POST',
      body: JSON.stringify({ agent, message, progress }),
    });
  }
  return data.task;
}

async function completeTask(id, agent) {
  await claimTask(id, agent).catch(() => null);
  await request(`/api/projects/${PROJECT}/tasks/${id}/complete`, {
    method: 'POST',
    body: JSON.stringify({ agent }),
  });
}

async function approveTask(id, reason) {
  await request(`/api/projects/${PROJECT}/tasks/${id}/approve`, {
    method: 'POST',
    body: JSON.stringify({ actor: 'release-lead', reason }),
  });
}

async function writeProjectFile(path, content) {
  await request(`/api/projects/${PROJECT}/files/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ content }),
  });
}

async function resetSupportProjects() {
  for (const [name, displayName, description, group, archived, order] of SUPPORT_PROJECTS) {
    await ensureProject({ name, displayName, description, group, archived, order });
  }
}

async function seedTasks() {
  await clearProjectTasks(PROJECT);

  const parent = await createTask({
    title: 'Launch landing page for Atelier Nova',
    priority: 'high',
    status: 'open',
  });
  const hero = await createTask({ title: 'Build hero section with final CTA hierarchy', parentId: parent.id });
  const editor = await createTask({ title: 'Draft launch playbook in Markdown editor', parentId: parent.id });
  const analytics = await createTask({ title: 'Wire analytics and conversion events', parentId: parent.id });
  const accessibility = await createTask({ title: 'Accessibility pass for launch page', parentId: parent.id });

  await claimTask(hero.id, 'design-agent', 'Hero layout framed; checking responsive edge cases.', 55);
  await claimTask(editor.id, 'content-agent', 'Launch playbook draft is in the editor with table, checklist, quote, and code block.', 70);
  await completeTask(accessibility.id, 'qa-agent');
  await approveTask(accessibility.id, 'Accessible color and keyboard pass accepted.');
  await updateTask(analytics.id, { status: 'review' });

  const design = await createTask({ title: 'Finalize responsive component states', priority: 'high', status: 'open' });
  const qa = await createTask({ title: 'Run release smoke on desktop and mobile', priority: 'high', status: 'open' });
  const content = await createTask({ title: 'Prepare SEO snippets and social preview', priority: 'medium', status: 'open' });
  const privacy = await createTask({ title: 'Audit privacy copy and consent wording', priority: 'medium', status: 'backlog' });
  const backlog = await createTask({ title: 'Compare three post-launch roadmap options', priority: 'low', status: 'backlog' });
  const review = await createTask({ title: 'Review pricing block microcopy', priority: 'medium', status: 'review' });
  const done = await createTask({ title: 'Approve visual direction and type scale', priority: 'high', status: 'open' });
  const blocked = await createTask({ title: 'Resolve final domain handover note', priority: 'medium', status: 'open' });

  await claimTask(design.id, 'design-agent', 'Component states are being checked across breakpoints.', 45);
  await claimTask(qa.id, 'qa-agent', 'Smoke matrix is running against the v5 fixture.', 35);
  await updateTask(blocked.id, { blocked: true });
  await claimTask(blocked.id, 'release-lead', 'Waiting for domain owner confirmation before DNS change.', 20);
  await completeTask(done.id, 'design-agent');
  await approveTask(done.id, 'Visual direction signed off for screenshot fixture.');

  // Milestones are tasks tagged milestone:<name> (T-315) — mixed statuses give
  // the widget partial-progress rings.
  await updateTask(parent.id, { tags: ['milestone:Public Launch'] });
  await updateTask(design.id, { tags: ['milestone:Public Launch'] });
  await updateTask(qa.id, { tags: ['milestone:Public Launch'] });
  await updateTask(done.id, { tags: ['milestone:Public Launch'] });
  await updateTask(content.id, { tags: ['milestone:Brand & Content'] });
  await updateTask(review.id, { tags: ['milestone:Brand & Content'] });
  await updateTask(privacy.id, { tags: ['milestone:Brand & Content'] });

  return { parentId: parent.id, editorTaskId: editor.id, reviewTaskId: review.id, contentTaskId: content.id };
}

async function seedFiles(taskIds) {
  // PROJECT.md is scaffolded at project creation; the hardened file endpoint
  // only accepts context/ and specs/ writes (T-355), so we don't rewrite it here.
  await writeProjectFile('context/launch-playbook.md', [
    '# Atelier Nova Launch Playbook',
    '',
    '> Launch pages work when strategy, copy, visual hierarchy, and QA all move together.',
    '',
    '## Goals',
    '',
    '- Ship a focused landing page for the first public campaign.',
    '- Make the call to action visible in hero, pricing, and footer.',
    '- Keep technical setup, privacy notes, and analytics reviewable by agents.',
    '',
    '## Launch Checklist',
    '',
    '- [x] Brand direction approved',
    '- [x] Core layout implemented',
    '- [ ] Final content pass',
    '- [ ] Mobile smoke test',
    '- [ ] DNS handover confirmed',
    '',
    '## Content Matrix',
    '',
    '| Section | Owner | Status | Notes |',
    '|---|---|---|---|',
    '| Hero | design-agent | In progress | CTA hierarchy under review |',
    '| Proof | content-agent | Draft | Add customer quote |',
    '| Pricing | release-lead | Review | Needs microcopy approval |',
    '| FAQ | qa-agent | Open | Check accessibility labels |',
    '',
    '## Tracking Snippet',
    '',
    '```js',
    "track('launch_cta_click', {",
    "  surface: 'hero',",
    "  campaign: 'atelier-nova-v1'",
    '});',
    '```',
    '',
    '## Links',
    '',
    '- [Campaign brief](./campaign-brief.md)',
    '- [Accessibility notes](../specs/accessibility-pass.md)',
    '',
  ].join('\n'));

  await writeProjectFile('context/campaign-brief.md', [
    '# Campaign Brief',
    '',
    'Audience: design-led founders who need a precise, fast launch page.',
    '',
    'Tone: clear, confident, concrete.',
    '',
    'Primary offer: launch-ready visual system and landing page in one focused sprint.',
    '',
  ].join('\n'));

  await writeProjectFile('specs/accessibility-pass.md', [
    '# Accessibility Pass',
    '',
    '## Done When',
    '',
    '- [x] Contrast checked',
    '- [x] Keyboard path checked',
    '- [x] CTA labels reviewed',
    '',
  ].join('\n'));

  await request(`/api/projects/${PROJECT}/tasks/${taskIds.editorTaskId}`, {
    method: 'PUT',
    body: JSON.stringify({ specFile: 'context/launch-playbook.md' }),
  });
}

async function seedCanvas() {
  // Canvas is DB-backed since ADR-0025 — seed via the canvas API, not canvas.json.
  // The backend assigns note ids (monotonic), so we map logical numbers → real ids.
  const existing = await request(`/api/projects/${PROJECT}/canvas`).catch(() => null);
  for (const note of existing?.notes || []) {
    await request(`/api/projects/${PROJECT}/canvas/notes/${note.id}`, { method: 'DELETE' }).catch(() => null);
  }

  const defs = [
    { n: 1, text: 'Hero direction: one concrete promise, one primary CTA', x: 80, y: 95, color: 'red', size: 'large' },
    { n: 2, text: 'Proof block: short customer quote plus launch metric', x: 370, y: 95, color: 'red', size: 'medium' },
    { n: 3, text: 'CTA hierarchy: hero, pricing, footer use same wording', x: 660, y: 95, color: 'red', size: 'medium' },
    { n: 4, text: 'Pricing copy: highlight one offer, reduce comparison noise', x: 110, y: 315, color: 'red', size: 'medium' },
    { n: 5, text: 'FAQ friction: answer objections before the handoff call', x: 405, y: 315, color: 'red', size: 'medium' },
    { n: 6, text: 'Content handoff: owners, deadlines, review notes in playbook', x: 700, y: 315, color: 'red', size: 'medium' },
    { n: 7, text: 'Analytics plan: track CTA, pricing, scroll depth, and form start', x: 1035, y: 100, color: 'green', size: 'large' },
    { n: 8, text: 'Event schema: stable names for release dashboard and QA', x: 1310, y: 100, color: 'green', size: 'medium' },
    { n: 9, text: 'Consent review: privacy wording checked before tracking ships', x: 1040, y: 330, color: 'green', size: 'medium' },
    { n: 10, text: 'Mobile smoke: CTA visible, forms usable, no layout breaks', x: 1310, y: 330, color: 'green', size: 'medium' },
    { n: 11, text: 'Launch gate: publish only after QA and analytics agree', x: 1175, y: 565, color: 'green', size: 'large' },
    { n: 12, text: 'Post-launch roadmap: save ideas that are not needed for v1', x: 430, y: 640, color: 'grey', size: 'small' },
    { n: 13, text: 'Localization later: keep copy adaptable, but out of launch scope', x: 720, y: 640, color: 'grey', size: 'small' },
  ];
  const idMap = {};
  for (const d of defs) {
    const created = await request(`/api/projects/${PROJECT}/canvas/notes`, {
      method: 'POST',
      body: JSON.stringify({ text: d.text, x: d.x, y: d.y, color: d.color, size: d.size }),
    });
    idMap[d.n] = created?.id ?? created?.note?.id ?? created?.note;
  }

  const conns = [
    { from: 1, to: 2, fromPort: 'right', toPort: 'left' },
    { from: 2, to: 3, fromPort: 'right', toPort: 'left' },
    { from: 1, to: 4, fromPort: 'bottom', toPort: 'top' },
    { from: 2, to: 5, fromPort: 'bottom', toPort: 'top' },
    { from: 3, to: 6, fromPort: 'bottom', toPort: 'top' },
    { from: 4, to: 5, fromPort: 'right', toPort: 'left' },
    { from: 5, to: 6, fromPort: 'right', toPort: 'left' },
    { from: 7, to: 8, fromPort: 'right', toPort: 'left' },
    { from: 7, to: 9, fromPort: 'bottom', toPort: 'top' },
    { from: 8, to: 10, fromPort: 'bottom', toPort: 'top' },
    { from: 9, to: 11, fromPort: 'bottom', toPort: 'left' },
    { from: 10, to: 11, fromPort: 'bottom', toPort: 'right' },
    { from: 12, to: 13, fromPort: 'right', toPort: 'left' },
  ];
  for (const c of conns) {
    if (idMap[c.from] == null || idMap[c.to] == null) continue;
    await request(`/api/projects/${PROJECT}/canvas/connections`, {
      method: 'POST',
      body: JSON.stringify({ from: idMap[c.from], to: idMap[c.to], fromPort: c.fromPort, toPort: c.toPort }),
    }).catch(() => null);
  }
}

async function seedOverview() {
  // Bind the public FlowBoard repo so the GitHub widgets render real public data.
  await request(`/api/projects/${PROJECT}/github`, {
    method: 'PUT',
    body: JSON.stringify({ repo: 'rasimme/FlowBoard' }),
  }).catch((e) => console.warn('github bind failed:', e.message));

  const repo = { repo: 'rasimme/FlowBoard' };
  // Repo-first overview: GitHub status/CI/PRs on top, focus/blocked/approvals,
  // releases/issues/milestones, then the board preview — a full, representative view.
  await request(`/api/projects/${PROJECT}/overview`, {
    method: 'PUT',
    body: JSON.stringify({
      version: 1,
      layout: 'grid',
      widgets: [
        { id: 'w-repo', type: 'repo-status', grid: { x: 0, y: 0, w: 5, h: 2 }, props: repo },
        { id: 'w-ci', type: 'gh-ci', grid: { x: 5, y: 0, w: 4, h: 2 }, props: repo },
        { id: 'w-pulls', type: 'gh-pulls', grid: { x: 9, y: 0, w: 3, h: 2 }, props: repo },
        { id: 'w-focus', type: 'current-focus', grid: { x: 0, y: 2, w: 5, h: 2 } },
        { id: 'w-blocked', type: 'blocked', grid: { x: 5, y: 2, w: 4, h: 2 } },
        { id: 'w-approvals', type: 'approvals', grid: { x: 9, y: 2, w: 3, h: 2 } },
        { id: 'w-releases', type: 'gh-releases', grid: { x: 0, y: 4, w: 4, h: 2 }, props: repo },
        { id: 'w-issues', type: 'gh-issues', grid: { x: 4, y: 4, w: 4, h: 2 }, props: repo },
        { id: 'w-milestones', type: 'milestones', grid: { x: 8, y: 4, w: 4, h: 2 } },
        { id: 'w-board', type: 'kanban-mini', grid: { x: 0, y: 6, w: 12, h: 2 } },
      ],
    }),
  }).catch((e) => console.warn('overview seed failed:', e.message));
}

async function activateAgents() {
  for (const agent of AGENTS) {
    await request('/api/status', {
      method: 'PUT',
      body: JSON.stringify({ agentId: agent, project: PROJECT }),
    });
  }
}

async function clearAgents() {
  for (const agent of AGENTS) {
    await request('/api/status', {
      method: 'PUT',
      body: JSON.stringify({ agentId: agent, project: null }),
    }).catch(() => null);
  }
}

async function seed() {
  await resetSupportProjects();
  const taskIds = await seedTasks();
  await seedFiles(taskIds);
  await seedCanvas();
  await seedOverview();
  await activateAgents();
  writeFileSync(
    join(repoRoot, '.flowboard-v5-demo.json'),
    JSON.stringify({ api: API, project: PROJECT, agents: AGENTS, ...taskIds }, null, 2)
  );
  console.log(`seeded ${PROJECT}`);
}

async function cleanup() {
  await clearAgents();
  await clearProjectTasks(PROJECT);
  for (const [name] of SUPPORT_PROJECTS) {
    await request(`/api/projects/${name}`, {
      method: 'PUT',
      body: JSON.stringify({ archived: true }),
    }).catch(() => null);
  }
  console.log(`cleaned ${PROJECT}`);
}

const command = process.argv[2] || 'seed';
if (command === 'seed') await seed();
else if (command === 'cleanup') await cleanup();
else {
  console.error('Usage: node scripts/v5-demo-fixture.mjs [seed|cleanup]');
  process.exit(1);
}
