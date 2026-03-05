import { api, toast, showModal, escHtml, formatDisplayName, registerDisplayNames } from './utils.js?v=6';
import {
  kanbanState, buildBoard, updateBoard, toggleSort, startAdd, cancelAdd,
  createTask, saveTitle, setPriority, setSubtaskStatus,
  confirmDelete, createSpec, onDrop, toggleExpand,
  startAddSubtask, cancelAddSubtask, submitSubtask,
  renderTabBarRight, bindKanbanEvents
} from './kanban.js?v=22';
import {
  fileState, loadFileTree, loadFileContent, saveFileContent, toggleFileEdit, toggleDir, fileBackToTree,
  renderFileExplorer, renderFileTree, applyStaticScrollbars, updateContentScrollbarVisibility,
  bindFileExplorerEvents
} from './file-explorer.js?v=8';
import {
  canvasState, renderIdeaCanvas,
  refreshCanvas, resetCanvasState
} from './canvas/index.js?v=5';

// Global state
const state = {
  projects: [],
  activeProject: null,
  viewedProject: null,
  tasks: [],
  currentTab: 'tasks',
  canvasNotes: [],
  canvasConnections: []
};

// Make state accessible to modules
window.appState = state;

let prevProjectsJson = '';
let prevTasksJson = '';
let prevActiveProject = null;
let prevFilesMeta = null; // flat [{path, mtime, size}] for change detection
let prevCanvasJson = '';

// Extract flat file fingerprint from a file tree for diffing
function getFilesMeta(tree) {
  const files = [];
  function walk(entries) {
    for (const e of entries) {
      if (e.type === 'file') files.push({ path: e.path, mtime: e.modified, size: e.size });
      if (e.children) walk(e.children);
    }
  }
  walk(tree || []);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// --- Sidebar toggle ---
function toggleSidebar() {
  document.getElementById('app').classList.toggle('sidebar-collapsed');
  window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light');
}

// --- Render functions ---
function renderSidebar() {
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
  if (state.currentTab === 'tasks') {
    renderTabBarRight();
    updateBoard(state);
  } else if (state.currentTab === 'files') {
    document.getElementById('tabBarRight').innerHTML = '';
    renderFileExplorer(state);
  } else if (state.currentTab === 'ideas') {
    document.getElementById('tabBarRight').innerHTML = '';
    renderIdeaCanvas(state);
  }
  requestAnimationFrame(applyStaticScrollbars);
}

// --- Actions ---
async function viewProject(name) {
  state.viewedProject = name;
  kanbanState.addingTask = false;
  kanbanState.editingTaskId = null;
  kanbanState.boardBuilt = false;
  fileState.fileTree = null;
  fileState.selectedFile = null;
  fileState.fileContent = null;
  prevFilesMeta = null; // Reset so next refresh re-baselines for new project
  resetCanvasState();
  prevCanvasJson = '';
  const data = await api(`/projects/${name}/tasks`);
  state.tasks = data.tasks || [];
  prevTasksJson = JSON.stringify(state.tasks);
  renderAll();
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
// Persisted kanban scroll position across tab switches
const savedKanbanScroll = { top: 0, colIndex: 0, columns: {} };

function switchTab(tab) {
  state.currentTab = tab;
  document.querySelectorAll('.tab').forEach(t => {
    t.classList.toggle('active', t.dataset.tab === tab);
  });
  if (tab === 'tasks') {
    kanbanState.boardBuilt = false;
    renderTabBarRight();
    updateBoard(state);
    // Restore scroll after board is painted — double rAF ensures layout is complete
    const saved = { ...savedKanbanScroll };
    requestAnimationFrame(() => requestAnimationFrame(() => {
      const isMobile = window.matchMedia('(max-width: 900px)').matches;
      if (isMobile) {
        const kanban = document.querySelector('.kanban');
        if (kanban) {
          // Restore horizontal column position
          if (saved.colIndex) {
            const colWidth = kanban.firstElementChild?.offsetWidth || 300;
            kanban.scrollLeft = saved.colIndex * colWidth;
          }
          // Restore each column's vertical scroll
          if (saved.columns) {
            kanban.querySelectorAll('.column[data-status]').forEach(col => {
              const top = saved.columns[col.dataset.status];
              if (top) col.scrollTop = top;
            });
          }
        }
      } else {
        const content = document.getElementById('content');
        if (content && saved.top) content.scrollTop = saved.top;
      }
      updateContentScrollbarVisibility();
    }));
  } else if (tab === 'files') {
    // Save kanban scroll before leaving
    const isMobile = window.matchMedia('(max-width: 900px)').matches;
    if (isMobile) {
      const kanban = document.querySelector('.kanban');
      if (kanban) {
        const colWidth = kanban.firstElementChild?.offsetWidth || 300;
        savedKanbanScroll.colIndex = Math.round(kanban.scrollLeft / colWidth);
        // Save each column's vertical scroll position
        savedKanbanScroll.columns = {};
        kanban.querySelectorAll('.column[data-status]').forEach(col => {
          savedKanbanScroll.columns[col.dataset.status] = col.scrollTop;
        });
      }
    } else {
      const content = document.getElementById('content');
      if (content) savedKanbanScroll.top = content.scrollTop;
    }
    document.getElementById('tabBarRight').innerHTML = '';
    renderFileExplorer(state);
    requestAnimationFrame(updateContentScrollbarVisibility);
  } else if (tab === 'ideas') {
    document.getElementById('tabBarRight').innerHTML = '';
    renderIdeaCanvas(state);
    requestAnimationFrame(updateContentScrollbarVisibility);
  }
}

// --- Kanban bridge callbacks (set on window._ for delegated handlers) ---
window._toggleSort = function() {
  if (toggleSort()) {
    kanbanState.boardBuilt = false;
    updateBoard(state);
  }
};
window._startAdd = function() { if (startAdd()) updateBoard(state); };
window._cancelAdd = function() { if (cancelAdd()) updateBoard(state); };
window._createTask = function() {
  createTask(state).then(changed => {
    if (changed) {
      prevTasksJson = JSON.stringify(state.tasks);
      updateBoard(state);
    }
  });
};
window._saveTitle = function(id, el) {
  saveTitle(id, el, state).then(() => {
    prevTasksJson = JSON.stringify(state.tasks);
  });
};
window._setPriority = function(id, priority) {
  setPriority(id, priority, state);
  prevTasksJson = JSON.stringify(state.tasks);
};
window._setSubtaskStatus = function(id, status) {
  setSubtaskStatus(id, status, state).then(changed => {
    if (changed) {
      prevTasksJson = JSON.stringify(state.tasks);
      updateBoard(state);
    }
  });
};
window._confirmDelete = function(id, deleteSpec = false, mode = null) {
  confirmDelete(id, state, deleteSpec, mode).then(changed => {
    if (changed) {
      prevTasksJson = JSON.stringify(state.tasks);
      updateBoard(state);
    }
  });
};
window._onDrop = function(e) { onDrop(e, state); };
window._toggleExpand = function(id) {
  toggleExpand(id);
  updateBoard(state);
};
window._addSubtask = function(id) {
  if (startAddSubtask(id)) updateBoard(state);
};
window._cancelSubtask = function() {
  if (cancelAddSubtask()) updateBoard(state);
};
window._submitSubtask = function() {
  submitSubtask(state).then(changed => {
    if (changed) {
      prevTasksJson = JSON.stringify(state.tasks);
      updateBoard(state);
    }
  });
};
window._openSpec = function(specPath, taskId) {
  if (!specPath) {
    toast(`No spec linked${taskId ? ` for ${taskId}` : ''}`, 'warn');
    return;
  }
  fileState.pendingOpen = specPath;
  switchTab('files');
};
window._createSpec = function(taskId) {
  createSpec(taskId, state).then(specFile => {
    if (specFile) {
      prevTasksJson = JSON.stringify(state.tasks);
      updateBoard(state);
      fileState.pendingOpen = specFile;
      switchTab('files');
    }
  });
};

// --- File Explorer bridge callbacks ---
window._loadFileContent = function(path) { loadFileContent(path, state); };
window.refreshCanvas = refreshCanvas;
window._saveFileContent = function() { saveFileContent(state); };
window._deleteCurrentFile = function() {
  const filePath = fileState?.selectedFile;
  if (!filePath) return;
  showModal('Delete File', `Delete <strong>${filePath}</strong>?`, async () => {
    try {
      const res = await fetch(`/api/projects/${state.viewedProject}/files/${filePath}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) { toast(data.error || 'Delete failed', 'error'); return; }
      toast(`Deleted ${filePath}`, 'success');
      fileBackToTree();
    } catch (err) { toast('Delete failed: ' + err.message, 'error'); }
  });
};

// --- User Interaction Detection ---
function isUserInteracting() {
  if (kanbanState.addingTask || kanbanState.editingTaskId || kanbanState.addingSubtaskParentId) return true;
  if (document.getElementById('modalOverlay')) return true;
  if (canvasState.editingId || canvasState.sidebarNoteId) return true;
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
      const taskData = await api(`/projects/${state.viewedProject}/tasks`);
      const newTasks = taskData.tasks || [];
      const tasksJson = JSON.stringify(newTasks);
      if (tasksJson !== prevTasksJson) {
        tasksChanged = true;
        state.tasks = newTasks;
        prevTasksJson = tasksJson;
      }
    }

    // --- File tree polling (always, silent update; render only when on files tab) ---
    let filesChanged = false;
    let changedFilePath = null;
    if (state.viewedProject) {
      try {
        const filesData = await api(`/projects/${state.viewedProject}/files`);
        const newMeta = getFilesMeta(filesData.tree);
        const newMetaJson = JSON.stringify(newMeta);
        const prevMetaJson = JSON.stringify(prevFilesMeta);
        if (newMetaJson !== prevMetaJson) {
          filesChanged = true;
          // Detect if the currently open file changed
          if (fileState.selectedFile && prevFilesMeta) {
            const prev = prevFilesMeta.find(f => f.path === fileState.selectedFile);
            const next = newMeta.find(f => f.path === fileState.selectedFile);
            if (next && (!prev || prev.mtime !== next.mtime)) changedFilePath = fileState.selectedFile;
          }
          prevFilesMeta = newMeta;
          fileState.fileTree = filesData; // Update silently (no extra fetch on tab switch)
        }
      } catch (e) { /* silent */ }
    }

    // --- Canvas polling (background, silent) ---
    if (state.viewedProject) {
      try {
        const canvasData = await api(`/projects/${state.viewedProject}/canvas`);
        const canvasJson = JSON.stringify(canvasData);
        if (canvasJson !== prevCanvasJson) {
          prevCanvasJson = canvasJson;
          canvasState.notes = canvasData.notes || [];
          canvasState.connections = canvasData.connections || [];
          // Only re-render if not actively editing or using sidebar
          if (state.currentTab === 'ideas' && !canvasState.editingId && !canvasState.sidebarNoteId) {
            refreshCanvas();
          }
        }
      } catch { /* silent */ }
    }

    if (isUserInteracting() && !projectsChanged) {
      return;
    }

    if (projectsChanged) { renderSidebar(); renderHeader(); }
    if (tasksChanged && state.currentTab === 'tasks') { updateBoard(state); }

    if (filesChanged && state.currentTab === 'files') {
      renderFileTree(); // Diff-update tree (new/deleted/renamed files appear instantly)

      // Selected file was deleted → auto-open first available file (same pattern as init)
      const selectedGone = fileState.selectedFile && !prevFilesMeta?.find(f => f.path === fileState.selectedFile);
      if (selectedGone) {
        fileState.selectedFile = null;
        fileState.fileContent = null;
        const firstFile = fileState.fileTree?.tree?.find(e => e.type === 'file');
        if (firstFile) loadFileContent(firstFile.path, state);
      } else if (changedFilePath && !fileState.fileEditing) {
        // Reload content if open file changed and not currently editing
        loadFileContent(changedFilePath, state);
      }
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
    const taskData = await api(`/projects/${state.viewedProject}/tasks`);
    state.tasks = taskData.tasks || [];
    prevTasksJson = JSON.stringify(state.tasks);

    // Initialize file meta baseline so first refresh doesn't false-positive
    try {
      const filesData = await api(`/projects/${state.viewedProject}/files`);
      fileState.fileTree = filesData;
      prevFilesMeta = getFilesMeta(filesData.tree);
    } catch (e) { /* silent */ }
  }

  // Bind delegated event listeners (once, on persistent containers)
  const content = document.getElementById('content');
  bindKanbanEvents(content);
  bindFileExplorerEvents(content);

  // Tab bar delegation
  document.getElementById('tabBar').addEventListener('click', e => {
    const tab = e.target.closest('[data-tab]');
    if (tab) switchTab(tab.dataset.tab);
    const action = e.target.closest('[data-action]')?.dataset.action;
    if (action === 'toggle-sort') window._toggleSort();
  });

  // Sidebar delegation
  document.getElementById('sidebar').addEventListener('click', e => {
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

// Viewport height now handled by pure CSS (100dvh) — no JS override needed
// Telegram's viewportStableHeight caused collapse on minimize/resume

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
      await fetch('/api/auth', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': tg.initData }
      });
    } catch (e) { console.warn('Auth failed:', e); }
  }
  await init();
})();
