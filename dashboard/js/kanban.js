// kanban.js — Task Board Logic

import { api, toast, showModal, escHtml, STATUS_KEYS, STATUS_LABELS, ICONS } from './utils.js?v=5';

// Telegram Haptic Feedback (no-op if not in Telegram)
const _h = (t='light') => window.Telegram?.WebApp?.HapticFeedback?.impactOccurred(t);
const _hn = (t='success') => window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred(t);

// Export state (shared with main)
export const kanbanState = {
  sortNewestFirst: localStorage.getItem('sortNewestFirst') !== 'false',
  addingTask: false,
  editingTaskId: null,
  selectedPriority: 'medium',
  boardBuilt: false,
  newCardIds: new Set(),
  expandedParents: new Set(),
  addingSubtaskParentId: null
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
>
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

  const allTasks = state.tasks;
  const tasks = allTasks.filter(t => !t.parentId);
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

    // Render subtask cards for expanded parents
    body.querySelectorAll('.subtask-card').forEach(el => el.remove());
    for (const task of sorted) {
      if (!task.subtaskIds?.length || !kanbanState.expandedParents.has(task.id)) continue;
      const parentCard = body.querySelector(`.task-card[data-id="${task.id}"]`);
      if (!parentCard) continue;
      const subtasks = allTasks.filter(t => t.parentId === task.id);
      let anchor = parentCard;
      for (const st of subtasks) {
        const el = document.createElement('div');
        el.className = `subtask-card parent-${task.priority}`;
        el.dataset.id = st.id;
        el.dataset.parentId = task.id;
        el.innerHTML = subtaskCardInner(st);
        anchor.after(el);
        anchor = el;
      }
    }

    // Render add-subtask inline input if active
    body.querySelectorAll('.add-subtask-form').forEach(el => el.remove());
    if (kanbanState.addingSubtaskParentId) {
      const parentCard = body.querySelector(`.task-card[data-id="${kanbanState.addingSubtaskParentId}"]`);
      if (parentCard) {
        let anchor = parentCard;
        let next = anchor.nextElementSibling;
        while (next && next.classList.contains('subtask-card') && next.dataset.parentId === kanbanState.addingSubtaskParentId) {
          anchor = next;
          next = anchor.nextElementSibling;
        }
        const form = document.createElement('div');
        form.className = 'add-subtask-form';
        form.innerHTML = `<input class="subtask-input" placeholder="Subtask title..." data-parent="${kanbanState.addingSubtaskParentId}">
          <div class="form-actions" style="margin-top:6px">
            <button class="btn btn-primary btn-sm" data-action="submit-subtask" data-id="${kanbanState.addingSubtaskParentId}">Add</button>
            <button class="btn btn-secondary btn-sm" data-action="cancel-subtask">Cancel</button>
          </div>`;
        anchor.after(form);
        setTimeout(() => {
          const inp = form.querySelector('.subtask-input');
          if (inp) {
            inp.focus();
            inp.addEventListener('keydown', e => {
              if (e.key === 'Enter') { if (window._submitSubtask) window._submitSubtask(); }
              if (e.key === 'Escape') { if (window._cancelSubtask) window._cancelSubtask(); }
            });
          }
        }, 50);
      }
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
            if (inp) {
              inp.addEventListener('keydown', e => {
                const action = onAddKey(e);
                if (action === 'create') { if (window._createTask) window._createTask(); }
                if (action === 'cancel') { if (window._cancelAdd) window._cancelAdd(); }
              });
            }
          }, 50);
        }
      } else {
        if (existingForm) existingForm.remove();
        if (existingBtn) {
          if (kanbanState.sortNewestFirst) body.insertBefore(existingBtn, body.firstChild);
          else body.appendChild(existingBtn);
        } else {
          body.insertAdjacentHTML(kanbanState.sortNewestFirst ? 'afterbegin' : 'beforeend',
            `<button class="add-task-btn" data-action="start-add">+ New Task</button>`);
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
  div.addEventListener('dragstart', e => onDragStart(e));
  div.addEventListener('dragend', e => onDragEnd(e));
  div.innerHTML = cardInnerHTML(task);
  return div;
}

function updateCardContent(card, task) {
  if (kanbanState.editingTaskId === task.id) return;
  // Parent cards: always re-render (progress bar needs fresh data)
  if (task.subtaskIds && task.subtaskIds.length > 0) {
    card.innerHTML = cardInnerHTML(task);
    return;
  }
  const titleEl = card.querySelector('.task-title');
  const pillEl = card.querySelector('.priority-pill');
  if (titleEl && titleEl.textContent !== task.title) titleEl.textContent = task.title;
  if (pillEl) {
    const newClass = `priority-pill priority-${task.priority}`;
    if (pillEl.className !== newClass || pillEl.textContent !== task.priority) {
      pillEl.className = newClass;
      pillEl.textContent = task.priority;
      pillEl.dataset.action = 'toggle-priority';
      pillEl.dataset.id = task.id;
      pillEl.dataset.priority = task.priority;
    }
  }
}

// Lucide-style SVG icons (24x24, stroke-based, matching Gateway Dashboard)
const ICON_TRASH = ICONS.trash;
const ICON_SPEC = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M10 13h4"/><path d="M10 17h4"/></svg>`;
const ICON_SPEC_ADD = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4"/><path d="M12 18v-6"/><path d="M9 15h6"/></svg>`;
const ICON_SUBTASK = `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12h-8"/><path d="M21 6h-8"/><path d="M21 18h-8"/><path d="M3 6v4c0 1.1.9 2 2 2h3"/><path d="M3 10v6c0 1.1.9 2 2 2h3"/></svg>`;

function cardInnerHTML(task) {
  const isEditing = kanbanState.editingTaskId === task.id;
  const hasUsableSpec = task.specFile && task.specExists !== false;
  const specBadge = hasUsableSpec
    ? `<span class="spec-badge" data-action="open-spec" data-file="${escHtml(task.specFile)}" data-id="${task.id}" title="Open spec file">${ICON_SPEC}</span>`
    : `<span class="spec-badge spec-badge-add" data-action="create-spec" data-id="${task.id}" title="Create spec file">${ICON_SPEC_ADD}</span>`;
  const subtaskBtn = `<span class="subtask-add-btn" data-action="add-subtask" data-id="${task.id}" title="Add subtask">${ICON_SUBTASK}</span>`;

  let progressHtml = '';
  if (task.progress && task.progress.total > 0) {
    const { done, inProgress, total } = task.progress;
    const isExpanded = kanbanState.expandedParents.has(task.id);
    const donePct = (done / total) * 100;
    const activePct = (inProgress / total) * 100;
    progressHtml = `<div class="subtask-progress" data-action="toggle-expand" data-id="${task.id}">
      <span class="expand-chevron${isExpanded ? ' expanded' : ''}">&#9654;</span>
      <div class="progress-bar">
        <div class="progress-done" style="width:${donePct}%"></div>
        <div class="progress-active" style="width:${activePct}%"></div>
      </div>
      <span class="progress-text">${done}/${total}</span>
    </div>`;
  }

  const subtaskCount = task.subtaskIds ? task.subtaskIds.length : 0;
  return `<div style="display:flex;justify-content:space-between;align-items:flex-start">
      <div class="task-id mono">${task.id}</div>
      <button class="delete-btn" data-action="delete-task" data-id="${task.id}" data-title="${escHtml(task.title)}" data-spec="${task.specFile || ''}" data-subtasks="${subtaskCount}" title="Delete task">${ICON_TRASH}</button>
    </div>
    ${isEditing
      ? `<input class="task-title-input" value="${escHtml(task.title)}" autofocus>`
      : `<div class="task-title" data-action="edit-task" data-id="${task.id}">${escHtml(task.title)}</div>`}
    <div class="task-meta">
      <span class="priority-pill-wrap">
        <span class="priority-pill priority-${task.priority}" data-action="toggle-priority" data-id="${task.id}" data-priority="${task.priority}">${task.priority}</span>
      </span>
      <span class="task-meta-actions">${subtaskBtn}${specBadge}</span>
    </div>${progressHtml}`;
}

function subtaskCardInner(task) {
  const hasUsableSpec = task.specFile && task.specExists !== false;
  const specBadge = hasUsableSpec
    ? `<span class="spec-badge spec-badge-sm" data-action="open-spec" data-file="${escHtml(task.specFile)}" data-id="${task.id}" title="Open spec file">${ICON_SPEC}</span>`
    : `<span class="spec-badge spec-badge-add spec-badge-sm" data-action="create-spec" data-id="${task.id}" title="Create spec file">${ICON_SPEC_ADD}</span>`;
  return `<div class="subtask-title">${escHtml(task.title)}</div>
    <div class="subtask-meta">
      <span class="status-dot-wrap" data-action="toggle-status" data-id="${task.id}" data-status="${task.status}">
        <span class="status-dot status-dot-${task.status}"></span>
      </span>
      ${specBadge}
      <span class="subtask-meta-spacer"></span>
      <button class="delete-btn" data-action="delete-task" data-id="${task.id}" data-title="${escHtml(task.title)}" data-spec="${task.specFile || ''}" data-subtasks="0" title="Delete subtask">${ICON_TRASH}</button>
    </div>`;
}

function renderAddTaskForm() {
  return `<div class="add-task-form">
    <input id="newTaskTitle" placeholder="Task title...">
    <div class="priority-selector">
      <button class="priority-option" data-p="low" data-action="select-priority" data-priority="low">low</button>
      <button class="priority-option selected" data-p="medium" data-action="select-priority" data-priority="medium">medium</button>
      <button class="priority-option" data-p="high" data-action="select-priority" data-priority="high">high</button>
    </div>
    <div class="form-actions">
      <button class="btn btn-primary btn-sm" data-action="create-task">Create</button>
      <button class="btn btn-secondary btn-sm" data-action="cancel-add">Cancel</button>
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

export function toggleExpand(id) {
  if (kanbanState.expandedParents.has(id)) {
    kanbanState.expandedParents.delete(id);
  } else {
    kanbanState.expandedParents.add(id);
  }
  return true; // Signal re-render
}

export function startAddSubtask(id) {
  kanbanState.addingSubtaskParentId = id;
  kanbanState.expandedParents.add(id);
  return true;
}

export function cancelAddSubtask() {
  kanbanState.addingSubtaskParentId = null;
  return true;
}

export async function submitSubtask(state) {
  const parentId = kanbanState.addingSubtaskParentId;
  if (!parentId) return;
  const inp = document.querySelector('.add-subtask-form .subtask-input');
  const title = inp ? inp.value.trim() : '';
  if (!title) return;
  const res = await api(`/projects/${state.viewedProject}/tasks`, {
    method: 'POST', body: { title, parentId }
  });
  if (res.ok) {
    state.tasks.push(res.task);
    const parent = state.tasks.find(t => t.id === parentId);
    if (parent) {
      if (!parent.subtaskIds) parent.subtaskIds = [];
      parent.subtaskIds.push(res.task.id);
      if (!parent.progress) parent.progress = { done: 0, inProgress: 0, total: 0 };
      parent.progress.total++;
    }
    kanbanState.addingSubtaskParentId = null;
    toast(`Subtask ${res.task.id} created`, 'success');
    _hn('success');
    return true;
  } else {
    toast(res.error || 'Error', 'error');
    _hn('error');
  }
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
    _hn('success');
    return true; // Signal re-render
  } else {
    toast(res.error || 'Error', 'error');
    _hn('error');
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
      if (inp) {
        inp.focus(); inp.select();
        inp.addEventListener('keydown', e => onTitleKey(e, id));
        inp.addEventListener('blur', () => { if (window._saveTitle) window._saveTitle(id, inp); });
      }
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
    pill.dataset.action = 'set-priority';
    pill.dataset.id = id;
    pill.dataset.priority = p;
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

// --- Status popover (subtask status dot) ---
const STATUS_OPTIONS = [
  { key: 'open', label: 'Open' },
  { key: 'in-progress', label: 'In Progress' },
  { key: 'review', label: 'Review' },
  { key: 'done', label: 'Done' }
];

export function toggleStatusPopover(e, id, current) {
  e.stopPropagation();
  document.querySelectorAll('.status-popover').forEach(p => p.remove());
  const wrap = e.target.closest('.status-dot-wrap');
  if (!wrap) return;
  const popover = document.createElement('div');
  popover.className = 'status-popover';
  STATUS_OPTIONS.forEach(s => {
    const opt = document.createElement('span');
    opt.className = `status-option${s.key === current ? ' current' : ''}`;
    opt.innerHTML = `<span class="status-dot status-dot-${s.key}"></span> ${s.label}`;
    opt.dataset.action = 'set-status';
    opt.dataset.id = id;
    opt.dataset.status = s.key;
    popover.appendChild(opt);
  });
  wrap.appendChild(popover);
  setTimeout(() => {
    const close = (ev) => {
      if (!popover.contains(ev.target)) { popover.remove(); document.removeEventListener('click', close); }
    };
    document.addEventListener('click', close);
  }, 0);
}

export async function setSubtaskStatus(id, status, state) {
  document.querySelectorAll('.status-popover').forEach(p => p.remove());
  const task = state.tasks.find(t => t.id === id);
  if (task) {
    task.status = status;
    if (status === 'done') task.completed = new Date().toISOString().slice(0, 10);
    else task.completed = null;
  }
  const res = await api(`/projects/${state.viewedProject}/tasks/${id}`, {
    method: 'PUT', body: { status }
  });
  if (res.ok) {
    toast(`${STATUS_LABELS[status]}`, 'success');
    _h('light');
    return true;
  } else {
    toast(res.error || 'Failed', 'error');
    _hn('error');
  }
}

export async function setPriority(id, priority, state) {
  document.querySelectorAll('.priority-popover').forEach(p => p.remove());
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  const pill = card?.querySelector('.priority-pill');
  if (pill) {
    pill.className = `priority-pill priority-${priority}`;
    pill.textContent = priority;
    pill.dataset.action = 'toggle-priority';
    pill.dataset.id = id;
    pill.dataset.priority = priority;
  }
  const task = state.tasks.find(t => t.id === id);
  if (task) task.priority = priority;
  await api(`/projects/${state.viewedProject}/tasks/${id}`, {
    method: 'PUT', body: { priority }
  });
}

export function startDelete(id, title, specFile, subtaskCount = 0) {
  if (subtaskCount > 0) {
    showModal(
      'Delete parent task?',
      `<strong>${id}</strong>: ${escHtml(title)}<br>This task has <strong>${subtaskCount}</strong> subtask(s).`,
      () => { if (window._confirmDelete) window._confirmDelete(id, false, 'all'); },
      'Delete all',
      'btn-danger',
      { label: 'Keep subtasks', onAction: () => { if (window._confirmDelete) window._confirmDelete(id, false, 'keep-children'); } }
    );
  } else if (specFile) {
    showModal(
      `\uD83D\uDDD1\uFE0F Delete task?`,
      `<strong>${id}</strong>: ${title}<br>This task has a spec file. Delete it too?`,
      () => { if (window._confirmDelete) window._confirmDelete(id, true); },
      'Delete everything',
      'btn-danger',
      { label: 'Keep spec', onAction: () => { if (window._confirmDelete) window._confirmDelete(id, false); } }
    );
  } else {
    showModal(
      'Delete task?',
      `<strong>${id}</strong>: ${title}<br>This action cannot be undone.`,
      () => { if (window._confirmDelete) window._confirmDelete(id, false); }
    );
  }
}

export async function confirmDelete(id, state, deleteSpec = false, mode = null) {
  const card = document.querySelector(`.task-card[data-id="${id}"]`);
  if (card) card.classList.add('removing');
  await new Promise(r => setTimeout(r, 250));
  const task = state.tasks.find(t => t.id === id);
  const specFile = task?.specFile;
  const url = mode
    ? `/projects/${state.viewedProject}/tasks/${id}?mode=${mode}`
    : `/projects/${state.viewedProject}/tasks/${id}`;
  const res = await api(url, { method: 'DELETE' });

  if (res.error === 'Task has subtasks') {
    if (card) card.classList.remove('removing');
    toast('Choose how to handle subtasks', 'warn');
    return;
  }

  if (res.ok) {
    if (mode === 'all') {
      const idsToRemove = new Set([id, ...(task?.subtaskIds || [])]);
      state.tasks = state.tasks.filter(t => !idsToRemove.has(t.id));
    } else if (mode === 'keep-children') {
      state.tasks = state.tasks.filter(t => t.id !== id);
      for (const t of state.tasks) {
        if (t.parentId === id) {
          t.parentId = null;
        }
      }
    } else {
      state.tasks = state.tasks.filter(t => t.id !== id);
      // If this was a subtask, update parent's subtaskIds in local state
      if (task?.parentId) {
        const parent = state.tasks.find(t => t.id === task.parentId);
        if (parent && parent.subtaskIds) {
          parent.subtaskIds = parent.subtaskIds.filter(sid => sid !== id);
        }
      }
    }
    if (deleteSpec && specFile) {
      await api(`/projects/${state.viewedProject}/files/${specFile}`, { method: 'DELETE' });
    }
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
  const col = e.target.closest('.column');
  if (col) col.classList.add('drag-over');
}

export function onDragLeave(e) {
  const col = e.target.closest('.column');
  if (col && !col.contains(e.relatedTarget)) col.classList.remove('drag-over');
}

export async function onDrop(e, state) {
  e.preventDefault();
  const col = e.target.closest('.column');
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
    _hn('error');
    updateBoard(state);
  } else {
    toast(`${task.title}: ${STATUS_LABELS[oldStatus]} → ${STATUS_LABELS[newStatus]}`, 'success');
    _h('medium');
  }
}

export function renderTabBarRight() {
  const el = document.getElementById('tabBarRight');
  if (!el) return;
  el.innerHTML = `<button class="btn btn-ghost btn-sm" data-action="toggle-sort" title="Toggle sort order"
    style="font-size:11px;display:flex;align-items:center;gap:4px;">
    <span id="sortIcon">${kanbanState.sortNewestFirst ? '↓' : '↑'}</span> <span id="sortLabel">${kanbanState.sortNewestFirst ? 'Newest first' : 'Oldest first'}</span>
  </button>`;
}

// --- Delegated event listener ---
export function bindKanbanEvents(container) {
  container.addEventListener('click', e => {
    const btn = e.target.closest('[data-action]');
    if (!btn) return;
    const { action, id, title, priority, file } = btn.dataset;
    switch (action) {
      case 'edit-task':       startEdit(id); break;
      case 'delete-task':     startDelete(id, title, btn.dataset.spec || null, parseInt(btn.dataset.subtasks) || 0); break;
      case 'toggle-expand':   if (window._toggleExpand) window._toggleExpand(id); break;
      case 'create-spec':     if (window._createSpec) window._createSpec(id); break;
      case 'open-spec':       if (window._openSpec) window._openSpec(file, id); break;
      case 'toggle-priority': togglePriorityPopover(e, id, priority); break;
      case 'set-priority':    if (window._setPriority) window._setPriority(id, priority); break;
      case 'toggle-status':   toggleStatusPopover(e, id, btn.dataset.status); break;
      case 'set-status':      if (window._setSubtaskStatus) window._setSubtaskStatus(id, btn.dataset.status); break;
      case 'create-task':     if (window._createTask) window._createTask(); break;
      case 'cancel-add':      if (window._cancelAdd) window._cancelAdd(); break;
      case 'start-add':       if (window._startAdd) window._startAdd(); break;
      case 'add-subtask':     if (window._addSubtask) window._addSubtask(id); break;
      case 'submit-subtask':  if (window._submitSubtask) window._submitSubtask(); break;
      case 'cancel-subtask':  if (window._cancelSubtask) window._cancelSubtask(); break;
      case 'select-priority': selectPriority(priority); break;
      case 'toggle-sort':     if (window._toggleSort) window._toggleSort(); break;
    }
  });

  // Column drag events (delegated)
  container.addEventListener('dragover', e => {
    const col = e.target.closest('.column');
    if (col) onDragOver(e);
  });
  container.addEventListener('dragleave', e => {
    const col = e.target.closest('.column');
    if (col) onDragLeave(e);
  });
  container.addEventListener('drop', e => {
    const col = e.target.closest('.column');
    if (col) { if (window._onDrop) window._onDrop(e); }
  });
}
