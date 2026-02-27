const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const cors = require('cors');

const app = express();
const PORT = 18790;
const HOST = '0.0.0.0';

const WORKSPACE = process.env.OPENCLAW_WORKSPACE || path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(WORKSPACE, 'projects');
const ACTIVE_PROJECT_FILE = path.join(WORKSPACE, 'ACTIVE-PROJECT.md');
const BOOTSTRAP_FILE = path.join(WORKSPACE, 'BOOTSTRAP.md');
const DASHBOARD_DATA_FILE = path.join(__dirname, 'dashboard-data.json');
const INDEX_FILE = path.join(PROJECTS_DIR, '_index.md');

// Gateway webhook config (for project-switch wake events)
const GATEWAY_PORT = process.env.OPENCLAW_GATEWAY_PORT || 18789;
const HOOKS_TOKEN = process.env.OPENCLAW_HOOKS_TOKEN || '';

// Auth config (from env vars — never hardcoded)
const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
const JWT_SECRET = process.env.JWT_SECRET || '';
const ALLOWED_USER_IDS = (process.env.ALLOWED_USER_IDS || '')
  .split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean);
const DASHBOARD_ORIGIN = process.env.DASHBOARD_ORIGIN || '';
const AUTH_ALWAYS = process.env.AUTH_ALWAYS === 'true';
const AUTH_ENABLED = !!(BOT_TOKEN && JWT_SECRET && ALLOWED_USER_IDS.length);

// --- Auth helpers ---

function validateTelegramWebApp(initData) {
  if (!initData || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get('hash');
  if (!hash) return null;
  const authDate = parseInt(params.get('auth_date'), 10);
  if (!authDate || Date.now() / 1000 - authDate > 3600) return null;
  params.delete('hash');
  const dataCheckString = [...params.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`).join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const checkHash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  if (checkHash !== hash) return null;
  const user = JSON.parse(params.get('user') || 'null');
  if (!user || !ALLOWED_USER_IDS.includes(user.id)) return null;
  return user;
}

function telegramAuthMiddleware(req, res, next) {
  if (!AUTH_ENABLED) return next(); // Auth nicht konfiguriert → offen lassen
  // AUTH_ALWAYS: Auth bei jedem Request (für ngrok, Tailscale, etc.)
  // Ohne AUTH_ALWAYS: nur externe Requests via Cloudflare Tunnel (CF-Ray Header)
  if (!AUTH_ALWAYS && !req.headers['cf-ray']) return next();
  // Optional: allow a custom hostname without auth (e.g. for LAN access via Cloudflare Tunnel)
  const cfHost = (req.headers['host'] || '').split(':')[0];
  const localHostname = process.env.LOCAL_HOSTNAME || '';
  if (localHostname && cfHost === localHostname) return next();
  const token = req.cookies?.flowboard_session;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
      return next();
    } catch { /* abgelaufen */ }
  }
  const initData = req.headers['x-telegram-init-data'];
  const user = validateTelegramWebApp(initData);
  if (!user) {
    console.warn(`[auth] Failed attempt from ${req.headers['cf-connecting-ip'] || req.ip} — ${new Date().toISOString()}`);
    return res.status(403).json({ error: 'Unauthorized' });
  }
  const sessionToken = jwt.sign({ id: user.id, username: user.username }, JWT_SECRET, { expiresIn: '8h' });
  res.cookie('flowboard_session', sessionToken, {
    httpOnly: true, secure: true, sameSite: 'none', maxAge: 8 * 60 * 60 * 1000
  });
  req.user = user;
  next();
}

// --- Middleware stack ---

app.use(cookieParser());
app.use(express.json());

// CORS — eigene Domain wenn konfiguriert, sonst wildcard (lokaler Zugriff)
if (DASHBOARD_ORIGIN) {
  app.use(cors({
    origin: DASHBOARD_ORIGIN,
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-Telegram-Init-Data']
  }));
} else {
  app.use(cors());
}

// Rate Limiting — max 60 Requests/Minute pro IP auf API-Routen
app.use('/api/', rateLimit({
  windowMs: 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.headers['cf-connecting-ip'] || req.ip,
  message: { error: 'Too many requests, please slow down.' }
}));

// Security + Cache Headers
app.use((req, res, next) => {
  // No-cache für JS/HTML
  if (req.path.endsWith('.js') || req.path.endsWith('.html') || req.path.endsWith('.css') || req.path === '/') {
    res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
  }
  // Security Headers
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://telegram.org",
    "connect-src 'self'",
    "img-src 'self' data: https://t.me",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-ancestors 'self' https://web.telegram.org"
  ].join('; '));
  next();
});

app.use(express.static(__dirname, {
  setHeaders: (res, filePath) => {
    // Never cache HTML — Telegram WebApp ignores query-param versioning on the HTML itself
    if (filePath.endsWith('.html')) {
      res.setHeader('Cache-Control', 'no-store');
    }
  }
}));

// Health-Endpoint (kein Auth)
const startTime = Date.now();
const pkg = require('./package.json');
app.get('/api/health', (req, res) => {
  res.json({
    ok: true,
    version: pkg.version,
    auth: AUTH_ENABLED,
    authAlways: AUTH_ALWAYS,
    uptime: Math.floor((Date.now() - startTime) / 1000)
  });
});

// Auth-Endpoint (vor dem generellen API-Auth)
app.post('/api/auth', telegramAuthMiddleware, (req, res) => {
  res.json({ ok: true, user: req.user });
});

// Auth auf alle weiteren API-Routes
app.use('/api/', telegramAuthMiddleware);

// --- Helpers ---

function readActiveProject() {
  try {
    const text = fs.readFileSync(ACTIVE_PROJECT_FILE, 'utf8');
    const match = text.match(/^project:\s*(.+)$/m);
    const name = match ? match[1].trim() : 'none';
    return name === 'none' ? null : name;
  } catch { return null; }
}

function writeActiveProject(name) {
  const content = name ? `project: ${name}\nsince: ${new Date().toISOString().slice(0, 10)}\n` : 'project: none\n';
  fs.writeFileSync(ACTIVE_PROJECT_FILE, content);
}

function readTasksFile(projectName) {
  const file = path.join(PROJECTS_DIR, projectName, 'tasks.json');
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch { return null; }
}

function taskWithSpecStatus(projectName, task) {
  const specFile = task?.specFile;
  const hasSpec = Boolean(specFile);
  const specExists = hasSpec && fs.existsSync(path.join(PROJECTS_DIR, projectName, specFile));
  return { ...task, specExists };
}

function enrichTasks(projectName, tasks = []) {
  return tasks.map(task => taskWithSpecStatus(projectName, task));
}

function writeTasksFile(projectName, data) {
  const file = path.join(PROJECTS_DIR, projectName, 'tasks.json');
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

function syncDashboardData(projectName) {
  const active = readActiveProject();
  const data = readTasksFile(projectName);
  const out = {
    project: projectName,
    active: active === projectName,
    tasks: data ? data.tasks : []
  };
  fs.writeFileSync(DASHBOARD_DATA_FILE, JSON.stringify(out, null, 2));
}

function getDisplayName(projectName) {
  try {
    const mdPath = path.join(PROJECTS_DIR, projectName, 'PROJECT.md');
    const firstLine = fs.readFileSync(mdPath, 'utf8').split('\n')[0];
    let title = firstLine.replace(/^#\s*/, '').trim();
    // Strip subtitle after em-dash or en-dash
    title = title.split(/\s*[—–]\s*/)[0].trim();
    return title || projectName;
  } catch { return projectName; }
}

function parseIndexMd() {
  try {
    const text = fs.readFileSync(INDEX_FILE, 'utf8');
    const lines = text.split('\n');
    const projects = [];
    for (const line of lines) {
      const match = line.match(/^\|\s*(\w[\w-]*)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|$/);
      if (match && match[1] !== 'Project') {
        projects.push({
          name: match[1],
          displayName: getDisplayName(match[1]),
          status: match[2],
          description: match[3]
        });
      }
    }
    return projects;
  } catch { return []; }
}

function getTaskCounts(projectName) {
  const data = readTasksFile(projectName);
  const counts = { open: 0, 'in-progress': 0, review: 0, done: 0 };
  if (data && data.tasks) {
    for (const t of data.tasks) {
      if (counts[t.status] !== undefined) counts[t.status]++;
    }
  }
  return counts;
}

function nextTaskId(tasks) {
  let max = 0;
  for (const t of tasks) {
    const m = t.id.match(/T-(\d+)/);
    if (m) max = Math.max(max, parseInt(m[1]));
  }
  return `T-${String(max + 1).padStart(3, '0')}`;
}

// --- Project Context Helpers ---

/**
 * Trim SESSION LOG in PROJECT.md to only the last N session entries.
 * Keeps everything before "## Session Log" intact, then appends
 * only the last N "### ..." entries from the log.
 */
function trimSessionLog(content, maxSessions = 2) {
  const sessionLogMatch = content.match(/^(## Session Log)\s*$/m);
  if (!sessionLogMatch) return content;

  const splitIndex = sessionLogMatch.index;
  const beforeLog = content.slice(0, splitIndex);
  const logSection = content.slice(splitIndex);

  const entryPattern = /^### .+$/gm;
  const matches = [];
  let match;
  while ((match = entryPattern.exec(logSection)) !== null) {
    matches.push(match.index);
  }

  if (matches.length === 0) return content;

  const entries = [];
  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : logSection.length;
    entries.push(logSection.slice(start, end).trimEnd());
  }

  const kept = entries.slice(0, maxSessions);
  const trimmedLog = `## Session Log\n\n${kept.join('\n\n')}\n`;
  return beforeLog + trimmedLog;
}

function updateBootstrapMd(projectName) {
  if (!projectName) {
    // No active project — clear BOOTSTRAP.md
    try { fs.writeFileSync(BOOTSTRAP_FILE, ''); } catch {}
    return;
  }

  const rulesPath = path.join(PROJECTS_DIR, 'PROJECT-RULES.md');
  const projectMdPath = path.join(PROJECTS_DIR, projectName, 'PROJECT.md');

  let rulesContent = '';
  let projectContent = '';
  try { rulesContent = fs.readFileSync(rulesPath, 'utf8'); } catch {}
  try { projectContent = fs.readFileSync(projectMdPath, 'utf8'); } catch {}

  // Smart Session Log trimming: keep only last 2 sessions in bootstrap
  if (projectContent) {
    projectContent = trimSessionLog(projectContent, 2);
  }

  const sections = [`# Active Project: ${projectName}\n`];
  if (rulesContent) sections.push(`## Project Rules\n\n${rulesContent}\n`);
  if (projectContent) sections.push(`## Project: ${projectName}\n\n${projectContent}\n`);

  try {
    fs.writeFileSync(BOOTSTRAP_FILE, sections.join('\n'));
    console.log(`[project-context] Updated BOOTSTRAP.md for project: ${projectName}`);
  } catch (err) {
    console.error(`[project-context] Failed to write BOOTSTRAP.md:`, err.message);
  }
}

async function sendWakeEvent(text) {
  if (!HOOKS_TOKEN) {
    console.log('[wake] No OPENCLAW_HOOKS_TOKEN set, skipping wake event');
    return;
  }
  try {
    const res = await fetch(`http://127.0.0.1:${GATEWAY_PORT}/hooks/wake`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${HOOKS_TOKEN}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ text, mode: 'now' })
    });
    if (res.ok) {
      console.log(`[wake] Sent wake event: ${text.slice(0, 80)}...`);
    } else {
      console.error(`[wake] Failed (${res.status}): ${await res.text()}`);
    }
  } catch (err) {
    console.error(`[wake] Error:`, err.message);
  }
}

// --- Routes ---

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ activeProject: readActiveProject() });
});

// PUT /api/status
app.put('/api/status', async (req, res) => {
  const { project } = req.body;
  const previousProject = readActiveProject();
  try {
    const effectiveProject = (project && project !== 'none') ? project : null;
    writeActiveProject(effectiveProject);
    updateBootstrapMd(effectiveProject);

    // Send wake event to notify agent of project switch
    if (effectiveProject) {
      const wakeText = previousProject && previousProject !== project
        ? `Projekt gewechselt von ${previousProject} auf ${project}. Lies BOOTSTRAP.md bzw. projects/${project}/PROJECT.md für den neuen Projekt-Context.`
        : `Projekt ${project} aktiviert. Lies BOOTSTRAP.md bzw. projects/${project}/PROJECT.md für den Projekt-Context.`;
      sendWakeEvent(wakeText);
    } else if (previousProject) {
      sendWakeEvent(`Projekt ${previousProject} deaktiviert. Kein aktives Projekt mehr.`);
    }

    res.json({ ok: true, activeProject: effectiveProject });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/projects
app.get('/api/projects', (req, res) => {
  const active = readActiveProject();
  const projects = parseIndexMd().map(p => ({
    ...p,
    taskCounts: getTaskCounts(p.name)
  }));
  res.json({ activeProject: active, projects });
});

// GET /api/projects/:name/tasks
app.get('/api/projects/:name/tasks', (req, res) => {
  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  res.json({ ...data, tasks: enrichTasks(req.params.name, data.tasks) });
});

// POST /api/projects/:name/tasks
app.post('/api/projects/:name/tasks', (req, res) => {
  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const { title, priority } = req.body;
  if (!title) return res.status(400).json({ error: 'Title required' });
  const task = {
    id: nextTaskId(data.tasks),
    title,
    status: 'open',
    priority: priority || 'medium',
    specFile: null,
    created: new Date().toISOString().slice(0, 10),
    completed: null
  };
  data.tasks.push(task);
  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    res.json({ ok: true, task: taskWithSpecStatus(req.params.name, task) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:name/tasks/:id
app.put('/api/projects/:name/tasks/:id', (req, res) => {
  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const task = data.tasks.find(t => t.id === req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  const updates = req.body;

  if (Object.prototype.hasOwnProperty.call(updates, 'specFile')) {
    const nextSpec = updates.specFile;
    if (nextSpec !== null) {
      if (typeof nextSpec !== 'string' || !nextSpec.trim()) {
        return res.status(400).json({ error: 'specFile must be a non-empty string or null' });
      }
      const resolvedSpec = path.resolve(PROJECTS_DIR, req.params.name, nextSpec);
      const projectRoot = path.resolve(PROJECTS_DIR, req.params.name) + path.sep;
      if (!resolvedSpec.startsWith(projectRoot)) {
        return res.status(400).json({ error: 'specFile path traversal not allowed' });
      }
      if (!fs.existsSync(resolvedSpec) || fs.statSync(resolvedSpec).isDirectory()) {
        return res.status(400).json({ error: `specFile target not found: ${nextSpec}` });
      }
    }
  }

  if (updates.status === 'done' && task.status !== 'done') {
    updates.completed = new Date().toISOString().slice(0, 10);
  }
  if (updates.status && updates.status !== 'done' && task.status === 'done') {
    updates.completed = null;
  }
  Object.assign(task, updates);
  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    res.json({ ok: true, task: taskWithSpecStatus(req.params.name, task) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:name/tasks/:id
app.delete('/api/projects/:name/tasks/:id', (req, res) => {
  const data = readTasksFile(req.params.name);
  if (!data) return res.status(404).json({ error: 'Project not found' });
  const idx = data.tasks.findIndex(t => t.id === req.params.id);
  if (idx === -1) return res.status(404).json({ error: 'Task not found' });
  data.tasks.splice(idx, 1);
  try {
    writeTasksFile(req.params.name, data);
    syncDashboardData(req.params.name);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- File Explorer API ---

// File loading categories
const ALWAYS_LOADED = new Set(['PROJECT.md']);
const MANDATORY_LAZY = new Set(['DECISIONS.md', 'tasks.json']);

function getFileCategory(relPath) {
  const basename = path.basename(relPath);
  if (ALWAYS_LOADED.has(basename) && !relPath.includes('/')) return 'always';
  if (MANDATORY_LAZY.has(basename) && !relPath.includes('/')) return 'lazy';
  return 'optional';
}

function buildFileTree(projectName) {
  const projectDir = path.join(PROJECTS_DIR, projectName);
  if (!fs.existsSync(projectDir)) return null;

  const entries = [];

  function walk(dir, relBase) {
    let items;
    try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const item of items) {
      const relPath = relBase ? `${relBase}/${item.name}` : item.name;
      const fullPath = path.join(dir, item.name);
      if (item.name.startsWith('.')) continue;
      if (item.isDirectory()) {
        entries.push({
          name: item.name,
          path: relPath,
          type: 'directory',
          children: []
        });
        walk(fullPath, relPath);
      } else {
        const stat = fs.statSync(fullPath);
        entries.push({
          name: item.name,
          path: relPath,
          type: 'file',
          size: stat.size,
          category: getFileCategory(relPath),
          modified: stat.mtime.toISOString()
        });
      }
    }
  }

  walk(projectDir, '');

  // Build nested tree
  const tree = [];
  const dirs = {};
  for (const e of entries) {
    if (e.type === 'directory') {
      dirs[e.path] = e;
    }
  }
  for (const e of entries) {
    const parent = e.path.includes('/') ? e.path.split('/').slice(0, -1).join('/') : null;
    if (parent && dirs[parent]) {
      dirs[parent].children.push(e);
    } else {
      tree.push(e);
    }
  }

  // Sort: directories first, then files; within each: always > lazy > optional
  const catOrder = { always: 0, lazy: 1, optional: 2 };
  function sortEntries(arr) {
    arr.sort((a, b) => {
      if (a.type !== b.type) return a.type === 'directory' ? 1 : -1; // files first at root
      if (a.type === 'file') {
        const ca = catOrder[a.category] ?? 2;
        const cb = catOrder[b.category] ?? 2;
        if (ca !== cb) return ca - cb;
      }
      return a.name.localeCompare(b.name);
    });
    for (const e of arr) {
      if (e.children) sortEntries(e.children);
    }
  }
  sortEntries(tree);

  // Calculate total size
  let totalSize = 0;
  for (const e of entries) {
    if (e.type === 'file') totalSize += e.size;
  }

  return { tree, totalSize, fileCount: entries.filter(e => e.type === 'file').length };
}

// GET /api/projects/:name/files
app.get('/api/projects/:name/files', (req, res) => {
  const result = buildFileTree(req.params.name);
  if (!result) return res.status(404).json({ error: 'Project not found' });
  res.json(result);
});

// GET /api/projects/:name/files/{*filePath} — read file content
app.get('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  if (!fs.existsSync(resolved) || fs.statSync(resolved).isDirectory()) {
    return res.status(404).json({ error: 'File not found' });
  }

  const stat = fs.statSync(resolved);
  if (stat.size > 500 * 1024) {
    return res.status(413).json({ error: 'File too large (max 500KB)' });
  }

  try {
    const content = fs.readFileSync(resolved, 'utf8');
    res.json({
      path: filePath,
      content,
      size: stat.size,
      category: getFileCategory(filePath),
      modified: stat.mtime.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/projects/:name/files/{*filePath} — write file content (Phase 2)
app.put('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  const { content } = req.body;
  if (content === undefined) return res.status(400).json({ error: 'Content required' });
  if (content.length > 100 * 1024) return res.status(413).json({ error: 'Content too large (max 100KB)' });

  try {
    // Ensure parent directory exists
    const dir = path.dirname(resolved);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

    fs.writeFileSync(resolved, content);
    const stat = fs.statSync(resolved);
    res.json({
      ok: true,
      path: filePath,
      size: stat.size,
      modified: stat.mtime.toISOString()
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/projects/:name/files/{*filePath} — delete files (only context/ and specs/)
app.delete('/api/projects/:name/files/{*filePath}', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  const filePath = Array.isArray(req.params.filePath) ? req.params.filePath.join('/') : req.params.filePath;

  // Security: prevent path traversal
  const resolved = path.resolve(projectDir, filePath);
  if (!resolved.startsWith(projectDir + path.sep) && resolved !== projectDir) {
    return res.status(403).json({ error: 'Path traversal not allowed' });
  }

  // Only allow deletion in context/ and specs/
  if (!filePath.startsWith('context/') && !filePath.startsWith('specs/')) {
    return res.status(403).json({ error: 'Only files in context/ and specs/ can be deleted' });
  }

  if (!fs.existsSync(resolved)) {
    return res.status(404).json({ error: 'File not found' });
  }

  if (fs.statSync(resolved).isDirectory()) {
    return res.status(403).json({ error: 'Cannot delete directories' });
  }

  try {
    fs.unlinkSync(resolved);

    // If it was a spec file, clean up the specFile link in tasks.json
    if (filePath.startsWith('specs/')) {
      const tasksFile = path.join(projectDir, 'tasks.json');
      if (fs.existsSync(tasksFile)) {
        const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
        const task = tasksData.tasks.find(t => t.specFile === filePath);
        if (task) {
          task.specFile = null;
          fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));
        }
      }
    }

    res.json({ ok: true, deleted: filePath });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/projects/:name/specs/:taskId — scaffold a new spec file
app.post('/api/projects/:name/specs/:taskId', (req, res) => {
  const projectDir = path.join(PROJECTS_DIR, req.params.name);
  if (!fs.existsSync(projectDir)) return res.status(404).json({ error: 'Project not found' });

  const taskId = req.params.taskId;
  const tasksFile = path.join(projectDir, 'tasks.json');
  if (!fs.existsSync(tasksFile)) return res.status(404).json({ error: 'tasks.json not found' });

  const tasksData = JSON.parse(fs.readFileSync(tasksFile, 'utf8'));
  const task = tasksData.tasks.find(t => t.id === taskId);
  if (!task) return res.status(404).json({ error: `Task ${taskId} not found` });
  if (task.specFile) {
    const existingSpec = path.join(projectDir, task.specFile);
    if (fs.existsSync(existingSpec) && !fs.statSync(existingSpec).isDirectory()) {
      return res.status(409).json({ error: 'Task already has a spec file', specFile: task.specFile });
    }
    // stale link: allow recreation and relink to a fresh spec file
  }

  // Generate slug from title
  const slug = task.title.toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 40)
    .replace(/-$/, '');

  const specFilename = `${taskId}-${slug}.md`;
  const specsDir = path.join(projectDir, 'specs');
  fs.mkdirSync(specsDir, { recursive: true });

  const specPath = path.join(specsDir, specFilename);
  const date = new Date().toISOString().slice(0, 10);
  const customContent = req.body?.content;
  const template = customContent || `# ${taskId}: ${task.title}\n\n## Goal\n\n\n## Done When\n- [ ] \n\n## Approach\n\n\n## Log\n- ${date}: Spec created\n`;

  fs.writeFileSync(specPath, template);

  // Link spec to task
  task.specFile = `specs/${specFilename}`;
  fs.writeFileSync(tasksFile, JSON.stringify(tasksData, null, 2));

  res.json({ ok: true, specFile: task.specFile, taskId, task: taskWithSpecStatus(req.params.name, task) });
});

app.listen(PORT, HOST, () => {
  console.log(`Dashboard API running on http://${HOST}:${PORT}`);
});
