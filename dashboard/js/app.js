import { api, toast, showModal, escHtml, formatDisplayName, registerDisplayNames } from './utils.js?v=9';
import { canvasState, renderIdeaCanvas, refreshCanvas, resetCanvasState } from './canvas/index.js?v=5';
import { resolveDashboardAgentId, selectViewedProject } from './project-selection.mjs';

// Global state
const state = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  canvasNotes: [],
  canvasConnections: [],
  currentTab: 'tasks',
  // T-161: per-agent active project state from flowboard_agents.
  // Each row: { agent_id, active_project, activated_at }
  agents: [],
  agentId: null,
};

// Make state accessible to modules
window.appState = state;

let prevProjectsJson = '';
let prevTasksJson = '';
let prevCanvasJson = '';
let prevActiveProject = null;
let prevAgentsJson = '';

async function fetchActiveProjectForAgent(agentId) {
  if (!agentId) return null;
  const data = await api(`/status?agentId=${encodeURIComponent(agentId)}`);
  if (data?.agentId !== agentId) {
    console.warn('[status] agentId mismatch', { requested: agentId, received: data?.agentId });
    return null;
  }
  return data.activeProject || null;
}

// --- Sidebar toggle ---
function toggleSidebar() {
  document.getElementById('app').classList.toggle('sidebar-collapsed');
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
}

// --- Render functions ---
function renderSidebar() {
  // When React owns the shell, skip legacy DOM render and notify React instead
  if (window._reactOwnsShell) { window._notifyReact?.(); return; }

  const list = document.getElementById('projectList');
  if (state.projects.length === 0) {
    list.innerHTML = '<div class="sidebar-empty">No projects</div>';
  } else {
    list.innerHTML = state.projects.map(p => {
      const isViewed = p.name === state.viewedProject;
      const openCount = (p.taskCounts.open || 0) + (p.taskCounts['in-progress'] || 0);
      let cls = 'project-item';
      if (isViewed) cls += ' viewed';
      return `<div class="${cls}" data-action="view-project" data-project="${p.name}">
        <span>${formatDisplayName(p.name)}</span>
        ${openCount > 0 ? `<span class="project-badge">${openCount}</span>` : ''}
      </div>`;
    }).join('');
  }

  const actions = document.getElementById('sidebarActions');
  if (state.viewedProject && state.viewedProject !== state.activeProject) {
    actions.innerHTML = `<button class="btn btn-primary btn-sm btn-full" data-action="activate-project">Activate</button>`;
  } else if (state.viewedProject && state.viewedProject === state.activeProject) {
    actions.innerHTML = `<button class="btn btn-secondary btn-sm btn-full" data-action="deactivate-project">Deactivate</button>`;
  } else {
    actions.innerHTML = '';
  }
}

function renderHeader() {
  // When React owns the shell, skip legacy DOM render and notify React instead
  if (window._reactOwnsShell) { window._notifyReact?.(); return; }

  const el = document.getElementById('headerRight');
  if (!state.viewedProject) { el.innerHTML = ''; return; }
  const isActive = state.viewedProject === state.activeProject;
  el.innerHTML = `
    <span class="header-project">${formatDisplayName(state.viewedProject)}</span>
    ${isActive ? '<span class="badge-active">Active</span>' : ''}
  `;
}

function renderAll() {
  renderSidebar();
  const app = document.querySelector('.app');
  app.setAttribute('data-view', state.currentTab);
  renderHeader();
}

// --- Actions ---
async function viewProject(name) {
  state.viewedProject = name;
  const data = await api(`/projects/${name}/tasks?includeArchived=true`);
  state.tasks = data.tasks || [];
  prevTasksJson = JSON.stringify(state.tasks);
  // Reset canvas state on project switch
  resetCanvasState();
  prevCanvasJson = '';
  renderAll();
  window._notifyReact?.();
}

async function activateProject() {
  if (!state.agentId) {
    toast('No agent context for activation.', 'warn');
    return;
  }
  await api('/status', { method: 'PUT', body: { project: state.viewedProject, agentId: state.agentId } });
  state.activeProject = state.viewedProject;
  toast(`Project "${state.viewedProject}" activated`, 'success');
  renderSidebar();
  renderHeader();
}

async function deactivateProject() {
  if (!state.agentId) {
    toast('No agent context for deactivation.', 'warn');
    return;
  }
  await api('/status', { method: 'PUT', body: { project: null, agentId: state.agentId } });
  state.activeProject = null;
  toast('Project deactivated.', 'info');
  renderSidebar();
  renderHeader();
}

// --- Tab System ---
function switchTab(tab) {
  state.currentTab = tab;
  if (window._reactOwnsShell) {
    window._notifyReact?.();
    // Canvas is legacy — render it when Ideas tab is active
    if (tab === 'ideas') {
      setTimeout(() => {
        const content = document.getElementById('content');
        if (content && !content.querySelector('.canvas-wrap')) {
          renderIdeaCanvas(state);
        }
      }, 50);
    }
  } else {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
  }
}

// T-136: React-triggered reload of the projects list after create/update/delete.
// Runs the same merge logic as refresh() but skips task/canvas fetching so the
// sidebar updates immediately without waiting on the 5s poll.
async function refreshProjectsOnly() {
  try {
    const data = await api('/projects');
    const newProjects = data.projects || [];
    const newAgents = await fetchAgents();
    const newActive = await fetchActiveProjectForAgent(state.agentId);
    state.projects = newProjects;
    state.agents = newAgents;
    registerDisplayNames(newProjects);
    state.activeProject = newActive;
    prevProjectsJson = JSON.stringify(state.projects);
    prevActiveProject = state.activeProject;
    if (state.viewedProject && !newProjects.some(p => p.name === state.viewedProject)) {
      state.viewedProject = selectViewedProject({
        projects: newProjects,
        agents: newAgents,
        activeProject: newActive,
      });
      state.tasks = [];
      prevTasksJson = '';
    }
    renderSidebar();
    renderHeader();
    window._notifyReact?.();
  } catch (err) {
    console.error('refreshProjectsOnly error:', err);
  }
}

// --- Shell bridge callbacks (React Header + Sidebar + TabBar) ---
window._viewProject = viewProject;
window._activateProject = activateProject;
window._deactivateProject = deactivateProject;
window._toggleSidebar = toggleSidebar;
window._switchTab = switchTab;
window._refreshProjects = refreshProjectsOnly;

// Spec file bridge — sets pending path and switches to files tab.
// When opened from a task (taskId given), the originating task is tracked so
// FilesView can render a "← Back to Task" button (T-221).
window._openSpec = function(specPath, taskId) {
  if (!specPath) {
    if (window.showToast) window.showToast(`No spec linked${taskId ? ` for ${taskId}` : ''}`, 'warn');
    return;
  }
  window.appState.pendingSpecFile = specPath;
  window.appState.pendingSpecTaskId = taskId || null;
  switchTab('files');
};

// --- User Interaction Detection ---
function isUserInteracting() {
  if (document.getElementById('modalOverlay')) return true;
  const active = document.activeElement;
  return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
}

// Separate fetch so a 503 (HZL disabled) doesn't take down the main refresh.
async function fetchAgents() {
  try {
    const data = await api('/agents');
    return Array.isArray(data?.agents) ? data.agents : [];
  } catch {
    return [];
  }
}

// --- Smart refresh ---
async function refresh() {
  try {
    const data = await api('/projects');
    const newProjects = data.projects || [];
    const newAgents = await fetchAgents();
    const newActive = await fetchActiveProjectForAgent(state.agentId);
    const projectsJson = JSON.stringify(newProjects);
    const projectsChanged = projectsJson !== prevProjectsJson || newActive !== prevActiveProject;

    state.projects = newProjects;
    registerDisplayNames(newProjects);
    state.activeProject = newActive;
    prevProjectsJson = projectsJson;
    prevActiveProject = newActive;

    // T-161: refresh multi-agent active-project state. Poll cadence matches
    // project refresh so sidebar pulse + active-context bar stay in sync
    // without an extra timer.
    const agentsJson = JSON.stringify(newAgents);
    const agentsChanged = agentsJson !== prevAgentsJson;
    if (agentsChanged) {
      state.agents = newAgents;
      prevAgentsJson = agentsJson;
    }

    if (!state.viewedProject) {
      state.viewedProject = selectViewedProject({
        projects: state.projects,
        agents: state.agents,
        activeProject: state.activeProject,
      });
    }

    let tasksChanged = false;
    if (state.viewedProject) {
      const taskData = await api(`/projects/${state.viewedProject}/tasks?includeArchived=true`);
      const newTasks = taskData.tasks || [];
      const tasksJson = JSON.stringify(newTasks);
      if (tasksJson !== prevTasksJson) {
        tasksChanged = true;
        state.tasks = newTasks;
        prevTasksJson = tasksJson;
      }
    }

    // Canvas data refresh
    let canvasChanged = false;
    if (state.viewedProject && state.currentTab === 'ideas') {
      try {
        const canvasData = await api(`/projects/${state.viewedProject}/canvas`);
        const canvasJson = JSON.stringify(canvasData);
        if (canvasJson !== prevCanvasJson) {
          canvasChanged = true;
          canvasState.notes = canvasData.notes || [];
          canvasState.connections = canvasData.connections || [];
          state.canvasNotes = canvasState.notes;
          state.canvasConnections = canvasState.connections;
          prevCanvasJson = canvasJson;
          if (!canvasState.editingId && !canvasState.dragging) {
            refreshCanvas();
          }
        }
      } catch (e) { console.warn('[canvas-refresh]', e); }
    }

    if (isUserInteracting() && !projectsChanged) {
      return;
    }

    if (projectsChanged || tasksChanged || agentsChanged) {
      renderSidebar();
      renderHeader();
      window._notifyReact?.();
    }
  } catch (err) {
    console.error('Refresh error:', err);
  }
}

// --- Init ---
async function init() {
  const data = await api('/projects');
  state.projects = data.projects || [];
  registerDisplayNames(state.projects);
  prevProjectsJson = JSON.stringify(state.projects);

  state.agents = await fetchAgents();
  prevAgentsJson = JSON.stringify(state.agents);
  state.activeProject = await fetchActiveProjectForAgent(state.agentId);
  prevActiveProject = state.activeProject;

  state.viewedProject = selectViewedProject({
    projects: state.projects,
    agents: state.agents,
    activeProject: state.activeProject,
  });

  if (state.viewedProject) {
    const taskData = await api(`/projects/${state.viewedProject}/tasks?includeArchived=true`);
    state.tasks = taskData.tasks || [];
    prevTasksJson = JSON.stringify(state.tasks);
  }

  // Tab bar delegation — React owns tab buttons when _reactOwnsShell is set;
  // legacy handler only needed for non-React fallback
  const tabBar = document.getElementById('tabBar');
  tabBar.addEventListener('click', e => {
    if (!window._reactOwnsShell) {
      const tab = e.target.closest('[data-tab]');
      if (tab) switchTab(tab.dataset.tab);
    }
  });

  // Sidebar delegation
  document.getElementById('sidebar').addEventListener('click', e => {
    if (window._reactOwnsShell) return; // React handles sidebar clicks
    const el = e.target.closest('[data-action]');
    if (!el) return;
    const { action, project } = el.dataset;
    if (action === 'view-project') viewProject(project);
    if (action === 'activate-project') activateProject();
    if (action === 'deactivate-project') deactivateProject();
  });

  // Header delegation (sidebar toggle)
  document.querySelector('.header').addEventListener('click', e => {
    const el = e.target.closest('[data-action]');
    if (!el) return;
    if (el.dataset.action === 'toggle-sidebar') toggleSidebar();
  });

  // Sidebar backdrop (close sidebar on click)
  document.querySelector('.sidebar-backdrop')?.addEventListener('click', () => {
    document.getElementById('app').classList.add('sidebar-collapsed');
  });

  renderAll();
  setInterval(refresh, 5000);
}

// Telegram WebApp integration
const tg = window.Telegram?.WebApp;

function haptic(type = 'light') {
  tg?.HapticFeedback?.impactOccurred(type);
}
function hapticNotification(type = 'success') {
  tg?.HapticFeedback?.notificationOccurred(type);
}

function applyTelegramTheme() {
  if (!tg?.themeParams) return;
  const { bg_color, text_color, hint_color, button_color, secondary_bg_color } = tg.themeParams;
  const r = document.documentElement;
  if (bg_color)           r.style.setProperty('--tg-bg', bg_color);
  if (text_color)         r.style.setProperty('--tg-text', text_color);
  if (hint_color)         r.style.setProperty('--tg-hint', hint_color);
  if (button_color)       r.style.setProperty('--tg-btn', button_color);
  if (secondary_bg_color) r.style.setProperty('--tg-secondary-bg', secondary_bg_color);
}

// External links via Telegram
document.addEventListener('click', e => {
  const link = e.target.closest('a[href]');
  if (!link) return;
  const href = link.href;
  if (tg && href.startsWith('http') && !href.includes(window.location.hostname)) {
    e.preventDefault();
    tg.openLink(href);
  }
});

// Telegram WebApp Auth + init
(async () => {
  if (tg?.initData) {
    tg.ready();
    tg.expand();
    tg.disableVerticalSwipes?.();
    applyTelegramTheme();
    tg.onEvent?.('themeChanged', applyTelegramTheme);
    try {
      const authRes = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': tg.initData },
        credentials: 'include'
      });
      const authData = await authRes.json().catch(() => null);
      if (authData?.user?.username) state.authUser = authData.user.username;
      state.agentId = resolveDashboardAgentId({
        urlSearch: window.location.search,
        telegramWebApp: tg,
        authAgentId: authData?.agentId,
        storedAgentId: localStorage.getItem('flowboard_agent_id'),
      });
    } catch (e) { console.warn('Auth failed:', e); }
  } else {
    state.agentId = resolveDashboardAgentId({
      urlSearch: window.location.search,
      telegramWebApp: tg,
      storedAgentId: localStorage.getItem('flowboard_agent_id'),
    });
  }
  if (state.agentId) {
    try { localStorage.setItem('flowboard_agent_id', state.agentId); } catch { /* ignore */ }
  }
  await init();
})();
