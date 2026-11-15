#!/usr/bin/env node
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { writeFileSync } from 'node:fs';
import { homedir } from 'node:os';

const API = process.env.FLOWBOARD_API || 'http://127.0.0.1:18700';
const PROJECT = 'flowboard-v5-demo';
const PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR
  || join(process.env.OPENCLAW_HOME || join(homedir(), '.openclaw'), 'projects');
const AGENTS = ['release-lead', 'design-agent', 'content-agent', 'qa-agent'];
const SUPPORT_PROJECTS = [
  ['flowboard-demo-core', 'Core Platform', 'Launcher platform infrastructure.', 'Launch Program', false, 10],
  ['flowboard-demo-brand', 'Brand System', 'Design system and brand assets.', 'Launch Program', false, 20],
  ['flowboard-demo-content', 'Content Studio', 'Editorial workflow for launch copy.', 'Launch Program', false, 30],
  [PROJECT, 'Website Launch Demo', 'Reusable public fixture for FlowBoard v5 screenshots.', 'Launch Program', false, 40],
  ['flowboard-demo-archive', 'Archived Sprint', 'Completed launch spike kept as archive example.', null, true, 90],
];
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const PROJECT_MD = [
  '# Website Launch Demo',
  '',
  '## Goal',
  'Launch a focused marketing site for Atelier Nova and coordinate design, content, QA, and release in FlowBoard.',
  '',
  '## Scope',
  '- Landing page: hero, proof, pricing, FAQ, footer — one primary CTA throughout',
  '- Launch analytics + consent review before tracking ships',
  '- Accessibility and mobile smoke as release gates',
  '',
  '## Operational state',
  'Current work, claims, review state, and next tasks live in FlowBoard tasks — not in this file.',
  '',
  '## Project files',
  '- context/launch-playbook.md — strategy, content matrix, tracking snippet',
  '- context/campaign-brief.md — audience, tone, offer',
  '- context/launch-metrics.md — target metrics + event schema',
  '- context/NOTES.md — freeform scratchpad (Notes widget)',
  '- specs/ — accessibility pass plus one spec per larger task (hero, analytics, release smoke)',
  '',
  '## Development rules',
  '- One primary CTA; measure before adding secondary actions.',
  '- Publish only after QA and analytics both pass.',
  '',
].join('\n');

const NOTES_MD = [
  '# Scratchpad',
  '',
  '- Hero copy v3 reads tighter — drop the second sentence.',
  '- @design-agent: confirm pricing card spacing on mobile (375px).',
  '- Open question: gate the FAQ behind the fold? leaning no.',
  '- Consent banner must load before any tracking pixel.',
  '- Post-launch: revisit localization once the first campaign settles.',
  '',
].join('\n');

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
  const data = await request(`/api/projects/${project}/tasks?includeArchived=true`);
  const tasks = data.tasks || [];
  const parents = tasks.filter((task) => !task.parentId);
  const children = tasks.filter((task) => task.parentId);

  for (const task of parents) {
    // T-417-23: cascade delete requires the typed confirmation token.
    await request(`/api/projects/${project}/tasks/${task.id}?mode=all`, { method: 'DELETE', body: JSON.stringify({ confirmation: 'delete-task-cascade' }) }).catch(() => null);
  }
  for (const task of children) {
    await request(`/api/projects/${project}/tasks/${task.id}`, { method: 'DELETE' }).catch(() => null);
  }
  await request(`/api/projects/${project}/tasks/trash`, { method: 'DELETE', body: JSON.stringify({ confirmation: 'empty-trash' }) }).catch(() => null);
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
  const sub = (parent, title, status = 'backlog', priority = 'medium') =>
    createTask({ title, status, priority, parentId: parent.id });

  // Three parents with subtasks in different states, so the board shows
  // structure and the parent progress bars are not all alike.
  const parent = await createTask({ title: 'Launch landing page for Atelier Nova', priority: 'high', status: 'open' });
  const hero = await sub(parent, 'Build hero section with final CTA hierarchy', 'open', 'high');
  const editor = await sub(parent, 'Draft launch playbook in Markdown editor', 'open');
  const analytics = await sub(parent, 'Wire analytics and conversion events', 'open');
  const accessibility = await sub(parent, 'Accessibility pass for launch page', 'open');

  const brand = await createTask({ title: 'Brand and content system', priority: 'medium', status: 'open' });
  const pricingCopy = await sub(brand, 'Write pricing and FAQ copy', 'open');
  const brandKit = await sub(brand, 'Export brand kit assets', 'open', 'low');
  const content = await sub(brand, 'Prepare SEO snippets and social preview', 'open');

  const release = await createTask({ title: 'Release readiness', priority: 'high', status: 'open' });
  const qa = await sub(release, 'Run release smoke on desktop and mobile', 'open', 'high');
  const blocked = await sub(release, 'Resolve final domain handover note', 'open');
  await sub(release, 'Set up uptime and error monitoring', 'backlog');
  await sub(release, 'Rehearse the rollback plan', 'open', 'low');

  await claimTask(hero.id, 'design-agent', 'Hero layout framed; checking responsive edge cases.', 55);
  await claimTask(editor.id, 'content-agent', 'Launch playbook draft is in the editor with table, checklist, quote, and code block.', 70);
  await completeTask(accessibility.id, 'qa-agent');
  await approveTask(accessibility.id, 'Accessible color and keyboard pass accepted.');
  await updateTask(analytics.id, { status: 'review' });

  await completeTask(pricingCopy.id, 'content-agent');
  await completeTask(brandKit.id, 'design-agent');
  await approveTask(brandKit.id, 'Brand kit exported and linked.');

  await claimTask(qa.id, 'qa-agent', 'Smoke matrix is running against the v5 fixture.', 35);
  await updateTask(blocked.id, { workState: 'blocked', workStateDetails: { reason: 'Waiting for domain owner confirmation' } });
  await claimTask(blocked.id, 'release-lead', 'Waiting for domain owner confirmation before DNS change.', 20);

  // Standalone tasks spread over every column and priority.
  const design = await createTask({ title: 'Finalize responsive component states', priority: 'high', status: 'open' });
  const privacy = await createTask({ title: 'Audit privacy copy and consent wording', priority: 'medium', status: 'backlog' });
  await createTask({ title: 'Compare three post-launch roadmap options', priority: 'low', status: 'backlog' });
  await createTask({ title: 'Scope localization for the second campaign', priority: 'low', status: 'backlog' });
  await createTask({ title: 'Draft the launch announcement email', priority: 'medium', status: 'open' });
  await createTask({ title: 'Collect three launch testimonials', priority: 'low', status: 'open' });
  const review = await createTask({ title: 'Review pricing block microcopy', priority: 'medium', status: 'review' });
  const done = await createTask({ title: 'Approve visual direction and type scale', priority: 'high', status: 'open' });
  const changelog = await createTask({ title: 'Publish the public changelog page', priority: 'low', status: 'open' });

  await claimTask(design.id, 'design-agent', 'Component states are being checked across breakpoints.', 45);
  await completeTask(done.id, 'design-agent');
  await approveTask(done.id, 'Visual direction signed off for screenshot fixture.');
  await completeTask(changelog.id, 'content-agent');
  await approveTask(changelog.id, 'Changelog page is live on staging.');

  // Milestones are tasks tagged milestone:<name> (T-315) — mixed statuses give
  // the widget partial-progress rings.
  for (const task of [parent, design, qa, done, release]) await updateTask(task.id, { tags: ['milestone:Public Launch'] });
  for (const task of [brand, content, review, privacy, pricingCopy]) await updateTask(task.id, { tags: ['milestone:Brand & Content'] });

  return {
    parentId: parent.id, brandParentId: brand.id, releaseParentId: release.id,
    editorTaskId: editor.id, reviewTaskId: review.id, contentTaskId: content.id,
    heroTaskId: hero.id, analyticsTaskId: analytics.id, smokeTaskId: qa.id,
  };
}

async function writeTaskSpec(taskId, title, lines) {
  // Specs are created through the spec endpoint, which names the file and
  // links it to the task.
  await request(`/api/projects/${PROJECT}/specs/${taskId}`, {
    method: 'POST',
    body: JSON.stringify({ title, content: lines.join('\n') }),
  }).catch((e) => console.warn(`spec for ${taskId} failed:`, e.message));
}

async function seedFiles(taskIds) {
  // Clean context/ so re-seeds don't accumulate stray files from older fixtures.
  const tree = await request(`/api/projects/${PROJECT}/files`).catch(() => null);
  for (const dir of ['context', 'specs']) {
    const entry = (tree?.tree || []).find((e) => e.name === dir && e.type === 'directory');
    for (const f of entry?.children || []) {
      if (f.type === 'file' && f.name.endsWith('.md')) {
        await request(`/api/projects/${PROJECT}/files/${dir}/${f.name}`, { method: 'DELETE' }).catch(() => null);
      }
    }
  }

  // PROJECT.md is a root file (the hardened endpoint blocks API root writes) — write it on disk.
  try { writeFileSync(join(PROJECTS_DIR, PROJECT, 'PROJECT.md'), PROJECT_MD); }
  catch (e) { console.warn('PROJECT.md write failed:', e.message); }

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

  await writeProjectFile('context/launch-metrics.md', [
    '# Launch Metrics',
    '',
    '## Targets',
    '- CTA click-through: > 6% on hero',
    '- Form start → submit: > 40%',
    '- Mobile bounce: < 55%',
    '',
    '## Event schema',
    '',
    '| event | surface | props |',
    '|---|---|---|',
    '| launch_cta_click | hero / pricing / footer | surface, campaign |',
    '| form_start | signup | field_count |',
    '| form_submit | signup | duration_ms |',
    '',
  ].join('\n'));

  await writeProjectFile('context/NOTES.md', NOTES_MD);

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

  await writeTaskSpec(taskIds.heroTaskId, 'hero-section', [
    '# Hero section',
    '',
    '## Goal',
    'One concrete promise and one primary CTA above the fold on every breakpoint.',
    '',
    '## Done when',
    '- [x] Headline and subline fit in two lines at 375px',
    '- [x] CTA wording matches pricing and footer',
    '- [ ] Hero image has a fixed aspect ratio (no layout shift)',
    '- [ ] Reviewed against the campaign brief',
    '',
  ]);
  await writeTaskSpec(taskIds.analyticsTaskId, 'analytics-events', [
    '# Analytics and conversion events',
    '',
    '## Events',
    '',
    '| event | fires on | required props |',
    '|---|---|---|',
    '| launch_cta_click | hero, pricing, footer CTA | surface, campaign |',
    '| form_start | first field focus | field_count |',
    '| form_submit | successful submit | duration_ms |',
    '',
    '## Done when',
    '- [x] Events fire once per interaction',
    '- [x] Nothing is tracked before consent',
    '- [ ] Dashboard shows the three funnel steps',
    '',
  ]);
  await writeTaskSpec(taskIds.smokeTaskId, 'release-smoke', [
    '# Release smoke',
    '',
    '## Matrix',
    '',
    '| device | browser | status |',
    '|---|---|---|',
    '| Desktop 1440 | Chrome, Safari, Firefox | passed |',
    '| Tablet 768 | Safari | passed |',
    '| Mobile 375 | Safari, Chrome | running |',
    '',
    '## Gate',
    'Publish only when every row passed and analytics agrees with the form count.',
    '',
  ]);
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
    { n: 14, text: 'Brand voice: precise, warm, no jargon', x: 110, y: 640, color: 'blue', size: 'medium' },
    { n: 15, text: 'Type scale: two weights, one accent colour', x: 110, y: 860, color: 'blue', size: 'small' },
    { n: 16, text: 'Open question: annual pricing toggle at launch?', x: 1600, y: 100, color: 'yellow', size: 'medium' },
    { n: 17, text: 'Open question: who owns the support inbox on day one?', x: 1600, y: 330, color: 'yellow', size: 'small' },
    { n: 18, text: 'Idea: launch-day status page with a live checklist', x: 1600, y: 565, color: 'teal', size: 'medium' },
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
    { from: 4, to: 14, fromPort: 'bottom', toPort: 'top' },
    { from: 14, to: 15, fromPort: 'bottom', toPort: 'top' },
    { from: 8, to: 16, fromPort: 'right', toPort: 'left' },
    { from: 16, to: 17, fromPort: 'bottom', toPort: 'top' },
    { from: 11, to: 18, fromPort: 'right', toPort: 'left' },
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
  // Standard "default" preset layout (matches a fresh project), with the Links
  // widget pre-populated so the board reads full. No GitHub widgets — keeps the
  // standard view and avoids depending on a bound repo.
  const links = [
    { label: 'Launch brief', url: 'https://example.com/atelier-nova/brief' },
    { label: 'Staging preview', url: 'https://staging.atelier-nova.example' },
    { label: 'Analytics', url: 'https://analytics.example.com/atelier-nova' },
    { label: 'Brand kit', url: 'https://example.com/brand' },
  ];
  await request(`/api/projects/${PROJECT}/overview`, {
    method: 'PUT',
    body: JSON.stringify({
      version: 1,
      layout: 'grid',
      preset: 'default',
      widgets: [
        { id: 'w-stall', type: 'stall-detection', grid: { x: 0, y: 0, w: 6, h: 3 } },
        { id: 'w-timeline', type: 'timeline', grid: { x: 6, y: 0, w: 3, h: 5 } },
        { id: 'w-drop', type: 'quick-drop', grid: { x: 9, y: 0, w: 3, h: 2 } },
        { id: 'w-context', type: 'context-index', grid: { x: 9, y: 2, w: 3, h: 3 } },
        { id: 'w-milestones', type: 'milestones', grid: { x: 0, y: 3, w: 3, h: 2 } },
        { id: 'w-quick', type: 'quick-links', grid: { x: 3, y: 3, w: 3, h: 2 } },
        { id: 'w-agents', type: 'active-agents', grid: { x: 0, y: 5, w: 5, h: 2 } },
        { id: 'w-notes', type: 'notes', grid: { x: 5, y: 5, w: 4, h: 2 } },
        { id: 'w-links', type: 'links', grid: { x: 9, y: 5, w: 3, h: 2 }, props: { links } },
        { id: 'w-stats', type: 'task-stats', grid: { x: 0, y: 7, w: 12, h: 2 } },
        { id: 'w-board', type: 'kanban-mini', grid: { x: 0, y: 9, w: 12, h: 2 } },
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
