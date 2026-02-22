// kanban.js — Task Board Logic

import { api, toast, showModal, escHtml, STATUS_KEYS, STATUS_LABELS, updateTimestamp } from './utils.js?v=2';

// Export state (shared with main)
export const kanbanState = {
  sortNewestFirst: localStorage.getItem('sortNewestFirst') !== 'false',
  addingTask: false,
  editingTaskId: null,
  selectedPriority: 'medium',
  boardBuilt: false,
  newCardIds: new Set()
};

// --- Sort ---
export function toggleSort() {
  kanbanState.sortNewestFirst = !kanbanState.sortNewestFirst;
  localStorage.setItem('sortNewestFirst', kanbanState.sortNewestFirst);
  const icon = document.getElementById('sortIcon');
  const label = document.getElementById('sortLabel');
  if (icon) icon.textContent = kanbanState.sortNewestFirst ? '↓' : '↑';
  if (label) label.textContent = kanbanState.sortNewestFirst ? 'Newest first' : 'Oldest first';
  return true; // Signal re-render needed
}

function sortTasks(tasks) {
  const dir = kanbanState.sortNewestFirst ? -1 : 1;
  return [...tasks].sort((a, b) => {
    const idA = parseInt(a.id.replace('T-', ''));
    const idB = parseInt(b.id.replace('T-', ''));
    return dir * (idA - idB);
  });
}

// --- Build board skeleton ---
export function buildBoard() {
  const content = document.getElementById('content');
  content.innerHTML = `<div class="kanban" id="kanban">
    ${STATUS_KEYS.map(status => `<div class="column" data-status="${status}"
      ondragover="window.onDragOver(event)" ondragleave="window.onDragLeave(event)" ondrop="window.onDrop(event)">
      <div class="column-header">
        <span class="column-title">${STATUS_LABELS[status]}</span>
        <span class="column-count" id="count-${status}">0</span>
      </div>
      <div class="column-body" id="col-${status}"></div>
    </div>`).join('')}
  </div>`;
  kanbanState.boardBuilt = true;
}

// --- Update board (diff-based) ---
export function updateBoard(state) {
  const content = document.getElementById('content');
  content.style.overflow = '';

  if (!state.viewedProject) {
    const msg = state.projects.length === 0
      ? 'No projects found. Create a new project via chat.'
      : 'Select a project from the sidebar.';
    content.innerHTML = `<div class="empty-state">${msg}</div>`;
    kanbanState.boardBuilt = false;
    return;
  }

  if (!kanbanState.boardBuilt) buildBoard();

  const tasks = state.tasks;
  const counts = {};
  STATUS_KEYS.forEach(s => counts[s] = 0);

  const grouped = {};
  STATUS_KEYS.forEach(s => grouped[s] = []);
  for (const t of tasks) {
    if (grouped[t.status]) grouped[t.status].push(t);
    counts[t.status]++;
  }

  STATUS_KEYS.forEach(status => {
    const sorted = sortTasks(grouped[status]);
    const body = document.getElementById(`col-${status}`);
    const countEl = document.getElementById(`count-${status}`);
    if (countEl) countEl.textContent = counts[status];

    const existingCards = {};
    body.querySelectorAll('.task-card').forEach(el => { existingCards[el.dataset.id] = el; });

    const newIds = new Set(sorted.map(t => t.id));
    for (const [id, el] of Object.entries(existingCards)) {
      if (!newIds.has(id)) el.remove();
    }

    const emptyEl = body.querySelector('.column-empty');
    const addBtn = body.querySelector('.add-task-btn');
    const addForm = body.querySelector('.add-task-form');

    if (sorted.length === 0 && !(status === 'open' && kanbanState.addingTask)) {
      if (!emptyEl) {
        const placeholder = document.createElement('div');
        placeholder.className = 'column-empty';
        placeholder.textContent = 'No tasks';
        if (addBtn) body.insertBefore(placeholder, addBtn);
        else if (addForm) body.insertBefore(placeholder, addForm);
        else body.appendChild(placeholder);
      }
    } else {
      if (emptyEl) emptyEl.remove();
    }

    let insertBefore = addBtn || addForm || null;
    for (let i = sorted.length - 1; i >= 0; i--) {
      const task = sorted[i];
      let card = body.querySelector(`.task-card[data-id="${task.id}"]`);
      if (!card) {
        card = createCardElement(task);
        if (kanbanState.newCardIds.has(task.id)) card.classList.add('new-card');
        body.insertBefore(card, insertBefore);
      } else {
        updateCardContent(card, task);
        body.insertBefore(card, insertBefore);
      }
      insertBefore = card;
    }

    if (status === 'open') {
      const existingBtn = body.querySelector('.add-task-btn');
      const existingForm = body.querySelector('.add-task-form');
      if (kanbanState.addingTask) {
        if (existingBtn) existingBtn.remove();
        if (existingForm) {
          if (kanbanState.sortNewestFirst) body.insertBefore(existingForm, body.firstChild);
          else body.appendChild(existingForm);
        } else {
          body.insertAdjacentHTML(kanbanState.sortNewestFirst ? 'afterbegin' : 'beforeend', renderAddTaskForm());
          setTimeout(() => {
            const inp = document.getElementById('newTaskTitle');
            if (inp && !inp.value) inp.focus();
          }, 50);
        }
      } else {
        if (existingForm) existingForm.remove();
        if (existingBtn) {
          if (kanbanState.sortNewestFirst) body.insertBefore(existingBtn, body.firstChild);
          else body.appendChild(existingBtn);
        } else {
          body.insertAdjacentHTML(kanbanState.sortNewestFirst ? 'afterbegin' : 'beforeend',
            `<button class="add-task-btn" onclick="window.startAdd()">+ New Task</button>`);
        }
      }
    }
  });

  if (kanbanState.newCardIds.size > 0) setTimeout(() => kanbanState.newCardIds.clear(), 400);
}

function createCardElement(task) {
  const div = document.createElement('div');
  div.className = 'task-card';
  div.draggable = true;
  div.dataset.id = task.id;
  div.setAttribute('ondragstart', 'window.onDragStart(event)');
  div.setAttribute('ondragend', 'window.onDragEnd(event)');
  div.innerHTML = cardInnerHTML(task);
  return div;
}

function updateCardContent(card, task) {
  if (kanbanState.editingTaskId === task.id) return;
  const titleEl = card.querySelector('.task-title');
  const pillEl = card.querySelector('.priority-pill');
  if (titleEl && titleEl.textContent !== task.title) titleEl.textContent = task.title;
  if (pillEl) {
    const newClass = `priority-pill priority-${task.priority}`;
    if (pillEl.className !== newClass || pillEl.textContent !== task.priority) {
      pillEl.className = newClass;
      pillEl.textContent = task.priority;
      pillEl.setAttribute('onclick', `window.togglePriorityPopover(event, '${task.id}', '${task.priority}')`);
    }
  }
}

// Lucide-style SVG icons (24x24, stroke-based, matching Gateway Dashboard)
const ICON_SPEC = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13h4"/><path d="M10 17h4"/></svg>`;
const ICON_SPEC_ADD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>`;

function cardInnerHTML(task) {
  const isEditing = kanbanState.editingTaskId === task.id;
  const hasUsableSpec = task.specFile && task.specExists !== false;
  const specBadge = hasUsableSpec
    ? `<span class="spec-badge" onclick="window.openSpec('${escHtml(task.specFile)}', '${task.id}')" title="Open spec file">${ICON_SPEC}</span>`
    : `<span class="spec-badge spec-badge-add" onclick="window.createSpec('${task.id}')" title="Create spec file">${ICON_SPEC_ADD}</span>`;
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="task-id mono">${task.id}</div>
      <button class="delete-btn" onclick="window.startDelete('${task.id}', '${escHtml(task.title)}')" title="Delete">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/>
        </svg>
      </button>
    </div>
    ${isEditing
      ? `<input class="task-title-input" value="${escHtml(task.title)}"
              onkeydown="window.onTitleKey(event, '${task.id}')" onblur="window.saveTitle('${task.id}', this)" autofocus>`
      : `<div class="task-title" onclick="window.startEdit('${task.id}')">${escHtml(task.title)}</div>`}
    <div class="task-meta">
      <span class="priority-pill-wrap">
        <span class="priority-pill priority-${task.priority}" onclick="window.togglePriorityPopover(event, '${task.id}', '${task.priority}')">${task.priority}</span>
      </span>
      ${specBadge}
    </div>`;
}

function renderAddTaskForm() {
  return `<div class="add-task-form">
    <input id="newTaskTitle" placeholder="Task title..." onkeydown="window.onAddKey(event)">
    <div class="priority-selector">
      <button class="priority-option" data-p="low" onclick="window.selectPriority('low')">low</button>
      <button class="priority-option selected" data-p="medium" onclick="window.selectPriority('medium')">medium</button>
      <button class="priority-option" data-p="high" onclick="window.selectPriority('high')">high</button>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" onclick="window.createTask()">Create</button>
      <button class="btn btn-secondary btn-sm" onclick="window.cancelAdd()">Cancel</button>
    </div>
  </div>`;
}

// --- Actions ---
export function startAdd() {
  kanbanState.addingTask = true;
  kanbanState.selectedPriority = 'medium';
  return true; // Signal re-render needed
}

export function cancelAdd() {
  kanbanState.addingTask = false;
  return true;
}

export function selectPriority(p) {
  kanbanState.selectedPriority = p;
  document.querySelectorAll('.priority-option').forEach(el => {
    el.classList.toggle('selected', el.dataset.p === p);
  });
}

export function onAddKey(e) {
  if (e.key === 'Enter') return 'create';
  if (e.key === 'Escape') return 'cancel';
}

export async function createTask(state) {
  const inp = document.getElementById('newTaskTitle');
  const title = inp ? inp.value.trim() : '';
  if (!title) return;
  const res = await api(`/projects/${state.viewedProject}/tasks`, {
    method: 'POST', body: { title, priority: kanbanState.selectedPriority }
  });
  if (res.ok) {
    state.tasks.push(res.task);
    kanbanState.addingTask = false;
    kanbanState.newCardIds.add(res.task.id);
    toast(`Task ${res.task.id} created`, 'success');
    return true; // Signal re-render
  } else {
    toast(res.error || 'Error', 'error');
  }
}

export function startEdit(id) {
  kanbanState.editingTaskId = id;
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (card) {
    const task = window.appState.tasks.find(t => t.id === id);
    if (task) card.innerHTML = cardInnerHTML(task);
    setTimeout(() => {
      const inp = card.querySelector('.task-title-input');
      if (inp) { inp.focus(); inp.select(); }
    }, 50);
  }
}

export function onTitleKey(e, id) {
  if (e.key === 'Enter') e.target.blur();
  if (e.key === 'Escape') {
    kanbanState.editingTaskId = null;
    const card = document.querySelector(`.task-card[data-id="${id}"]`);
    const task = window.appState.tasks.find(t => t.id === id);
    if (card && task) card.innerHTML = cardInnerHTML(task);
  }
}

export async function saveTitle(id, el, state) {
  const newTitle = el.value.trim();
  kanbanState.editingTaskId = null;
  const task = state.tasks.find(t => t.id === id);
  if (task && newTitle && task.title !== newTitle) {
    await api(`/projects/${state.viewedProject}/tasks/${id}`, {
      method: 'PUT', body: { title: newTitle }
    });
    task.title = newTitle;
    toast('Title updated', 'success');
  }
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (card && task) card.innerHTML = cardInnerHTML(task);
}

export function togglePriorityPopover(e, id, current) {
  e.stopPropagation();
  document.querySelectorAll('.priority-popover').forEach(p => p.remove());
  const wrap = e.target.closest('.priority-pill-wrap');
  if (!wrap) return;
  const popover = document.createElement('div');
  popover.className = 'priority-popover';
  ['low', 'medium', 'high'].forEach(p => {
    const pill = document.createElement('span');
    pill.className = `priority-pill priority-${p}${p === current ? ' current' : ''}`;
    pill.textContent = p;
    pill.onclick = (ev) => { ev.stopPropagation(); window.setPriority(id, p); };
    popover.appendChild(pill);
  });
  wrap.appendChild(popover);
  setTimeout(() => {
    const close = (ev) => {
      if (!popover.contains(ev.target)) { popover.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

export async function setPriority(id, priority, state) {
  document.querySelectorAll('.priority-popover').forEach(p => p.remove());
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  const pill = card?.querySelector('.priority-pill');
  if (pill) {
    pill.className = `priority-pill priority-${priority}`;
    pill.textContent = priority;
    pill.setAttribute('onclick', `window.togglePriorityPopover(event, '${id}', '${priority}')`);
  }
  const task = state.tasks.find(t => t.id === id);
  if (task) task.priority = priority;
  await api(`/projects/${state.viewedProject}/tasks/${id}`, {
    method: 'PUT', body: { priority }
  });
}

export function startDelete(id, title) {
  showModal(
    'Delete task?',
    `<strong>${id}</strong>: ${title}<br>This action cannot be undone.`,
    () => window.confirmDelete(id)
  );
}

export async function confirmDelete(id, state) {
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (card) card.classList.add('removing');
  await new Promise(r => setTimeout(r, 250));
  const res = await api(`/projects/${state.viewedProject}/tasks/${id}`, { method: 'DELETE' });
  if (res.ok) {
    state.tasks = state.tasks.filter(t => t.id !== id);
    toast('Task deleted', 'success');
    return true; // Signal re-render
  }
}

// --- Spec files ---
export async function createSpec(taskId, state) {
  const res = await api(`/projects/${state.viewedProject}/specs/${taskId}`, { method: 'POST' });
  if (res.ok) {
    const task = state.tasks.find(t => t.id === taskId);
    if (task) task.specFile = res.specFile;
    toast(`Spec created for ${taskId}`, 'success');
    return res.specFile; // Signal to open it
  } else {
    toast(res.error || 'Failed to create spec', 'error');
    return null;
  }
}

// --- Drag & Drop ---
let draggedId = null;

export function onDragStart(e) {
  draggedId = e.currentTarget.dataset.id;
  e.currentTarget.classList.add('dragging');
  e.dataTransfer.effectAllowed = 'move';
}

export function onDragEnd(e) {
  e.currentTarget.classList.remove('dragging');
  document.querySelectorAll('.column').forEach(c => c.classList.remove('drag-over'));
  draggedId = null;
}

export function onDragOver(e) {
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
  const col = e.currentTarget.closest('.column');
  if (col) col.classList.add('drag-over');
}

export function onDragLeave(e) {
  const col = e.currentTarget.closest('.column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
}

export async function onDrop(e, state) {
  e.preventDefault();
  const col = e.currentTarget.closest('.column');
  if (!col || !draggedId) return;
  col.classList.remove('drag-over');

  const newStatus = col.dataset.status;
  const task = state.tasks.find(t => t.id === draggedId);
  if (!task || task.status === newStatus) return;

  const oldStatus = task.status;
  task.status = newStatus;
  if (newStatus === 'done') task.completed = new Date().toISOString().slice(0, 10);
  if (oldStatus === 'done' && newStatus !== 'done') task.completed = null;

  updateBoard(state);

  const res = await api(`/projects/${state.viewedProject}/tasks/${draggedId}`, {
    method: 'PUT', body: { status: newStatus }
  });
  if (!res.ok) {
    task.status = oldStatus;
    toast('Failed to move task', 'error');
    updateBoard(state);
  } else {
    toast(`${task.title}: ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}`, 'success');
  }
}

export function renderTabBarRight() {
  const el = document.getElementById('tabBarRight');
  if (!el) return;
  el.innerHTML = `<button class="btn btn-ghost btn-sm" onclick="window.toggleSort()" title="Toggle sort order"
    style="font-size:11px;display:flex;align-items:center;gap:4px;">
    <span id="sortIcon">${kanbanState.sortNewestFirst ? '↓' : '↑'}</span> <span id="sortLabel">${kanbanState.sortNewestFirst ? 'Newest first' : 'Oldest first'}</span>
  </button>`;
}
