const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = 3001;
const HOST = '0.0.0.0';

const WORKSPACE = path.resolve(__dirname, '..');
const PROJECTS_DIR = path.join(WORKSPACE, 'projects');
const ACTIVE_PROJECT_FILE = path.join(WORKSPACE, 'ACTIVE-PROJECT.md');
const DASHBOARD_DATA_FILE = path.join(__dirname, 'dashboard-data.json');
const INDEX_FILE = path.join(PROJECTS_DIR, '_index.md');

// Middleware
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});
app.use(express.static(__dirname));

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

function parseIndexMd() {
  try {
    const text = fs.readFileSync(INDEX_FILE, 'utf8');
    const lines = text.split('\n');
    const projects = [];
    for (const line of lines) {
      const match = line.match(/^\|\s*(\w[\w-]*)\s*\|\s*(\w+)\s*\|\s*(.+?)\s*\|$/);
      if (match && match[1] !== 'Project') {
        projects.push({ name: match[1], status: match[2], description: match[3] });
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

// --- Routes ---

// GET /api/status
app.get('/api/status', (req, res) => {
  res.json({ activeProject: readActiveProject() });
});

// PUT /api/status
app.put('/api/status', (req, res) => {
  const { project } = req.body;
  try {
    writeActiveProject(project || null);
    res.json({ ok: true, activeProject: project || null });
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
  res.json(data);
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
    res.json({ ok: true, task });
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
    res.json({ ok: true, task });
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

app.listen(PORT, HOST, () => {
  console.log(`Dashboard API running on http://${HOST}:${PORT}`);
});
