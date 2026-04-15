import { api, toast, showModal, escHtml, formatDisplayName, registerDisplayNames } from './utils.js?v=9';

// Global state
const state = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  currentTab: 'tasks'
};

// Make state accessible to modules
window.appState = state;

let prevProjectsJson = '';
let prevTasksJson = '';
let prevActiveProject = null;

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
      const isActive = p.name === state.activeProject;
      const isViewed = p.name === state.viewedProject;
      const openCount = (p.taskCounts.open || 0) + (p.taskCounts['in-progress'] || 0);
      let cls = 'project-item';
      if (isActive) cls += ' agent-active';
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
  renderAll();
  window._notifyReact?.();
}

async function activateProject() {
  await api('/status', { method: 'PUT', body: { project: state.viewedProject } });
  state.activeProject = state.viewedProject;
  toast(`Project "${state.viewedProject}" activated`, 'success');
  renderSidebar();
  renderHeader();
}

async function deactivateProject() {
  await api('/status', { method: 'PUT', body: { project: null } });
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
  } else {
    document.querySelectorAll('.tab').forEach(t => {
      t.classList.toggle('active', t.dataset.tab === tab);
    });
  }
}

// --- Shell bridge callbacks (React Header + Sidebar + TabBar) ---
window._viewProject = viewProject;
window._activateProject = activateProject;
window._deactivateProject = deactivateProject;
window._toggleSidebar = toggleSidebar;
window._switchTab = switchTab;

// Spec file bridge — sets pending path and switches to files tab
window._openSpec = function(specPath, taskId) {
  if (!specPath) {
    if (window.showToast) window.showToast(`No spec linked${taskId ? ` for ${taskId}` : ''}`, 'warn');
    return;
  }
  window.appState.pendingSpecFile = specPath;
  switchTab('files');
};

// --- User Interaction Detection ---
function isUserInteracting() {
  if (document.getElementById('modalOverlay')) return true;
  const active = document.activeElement;
  return active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA');
}

// --- Smart refresh ---
async function refresh() {
  try {
    const data = await api('/projects');
    const newProjects = data.projects || [];
    const newActive = data.activeProject;
    const projectsJson = JSON.stringify(newProjects);
    const projectsChanged = projectsJson !== prevProjectsJson || newActive !== prevActiveProject;

    state.projects = newProjects;
    registerDisplayNames(newProjects);
    state.activeProject = newActive;
    prevProjectsJson = projectsJson;
    prevActiveProject = newActive;

    if (!state.viewedProject) {
      if (state.activeProject) state.viewedProject = state.activeProject;
      else if (state.projects.length > 0) state.viewedProject = state.projects[0].name;
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

    if (isUserInteracting() && !projectsChanged) {
      return;
    }

    if (projectsChanged || tasksChanged) {
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
  state.activeProject = data.activeProject;
  prevProjectsJson = JSON.stringify(state.projects);
  prevActiveProject = state.activeProject;

  if (state.activeProject) state.viewedProject = state.activeProject;
  else if (state.projects.length > 0) state.viewedProject = state.projects[0].name;

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
        headers: { 'X-Telegram-Init-Data': tg.initData }
      });
      const authData = await authRes.json().catch(() => null);
      if (authData?.user?.username) state.authUser = authData.user.username;
    } catch (e) { console.warn('Auth failed:', e); }
  }
  await init();
})();
