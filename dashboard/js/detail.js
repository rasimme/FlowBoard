// detail.js — Task Detail Slide-over Panel

import { api, toast, escHtml, STATUS_LABELS } from './utils.js?v=9';

export const detailState = {
  activeTaskId: null,
  activeProject: null,
  _task: null,       // cached task for action bar state
  _hzlAvailable: true // assume available until proven otherwise
};

/** Get current user agent name from auth context, fallback to 'unknown' */
function _currentAgent() {
  return window.appState?.authUser || 'unknown';
}

let _pollInterval = null;

function fmtTime(ts) {
  if (!ts) return '--:--';
  const d = new Date(ts);
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const HH = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${dd}.${mm}. ${HH}:${min}`;
}

export function initDetail(project) {
  detailState.activeProject = project;

  const closeBtn = document.getElementById('closeDetail');
  if (closeBtn) closeBtn.onclick = closeTaskDetail;

  const sendBtn = document.getElementById('sendComment');
  if (sendBtn) sendBtn.onclick = submitComment;

  const textarea = document.getElementById('commentText');
  if (textarea) {
    textarea.onkeydown = (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        submitComment();
      }
    };
  }

  // Delegated click handler for action bar buttons
  const actionsEl = document.getElementById('detailActions');
  if (actionsEl) {
    actionsEl.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-action]');
      if (!btn || btn.disabled) return;
      const action = btn.dataset.action;
      if (action === 'detail-claim') handleClaim();
      else if (action === 'detail-release') handleRelease();
      else if (action === 'detail-complete') handleComplete();
      else if (action === 'detail-toggle-blocked') handleToggleBlocked();
    });
  }
}

export async function openTaskDetail(taskId) {
  detailState.activeTaskId = taskId;
  detailState._task = null;
  detailState._hzlAvailable = true; // fresh chance each panel open
  _stopPolling();

  const panel = document.getElementById('taskDetailPanel');
  const overlay = document.querySelector('.board-overlay') || createOverlay();

  panel.classList.remove('hide');
  overlay.classList.add('active');

  // Initial UI state
  document.getElementById('detailTaskId').textContent = taskId;
  document.getElementById('detailTitle').textContent = 'Lade...';
  document.getElementById('activityFeed').innerHTML = '<div class="activity-loading">Daten werden geladen…</div>';
  renderActionBar(null); // clear while loading

  try {
    const task = await fetchTask(taskId);
    if (!task) throw new Error('Task nicht gefunden');

    detailState._task = task;

    document.getElementById('detailTitle').textContent = task.title;
    const descEl = document.getElementById('detailDescription');
    if (descEl) {
      descEl.innerHTML = `
        <div class="detail-section-title">Task</div>
        <div style="font-size:14px;line-height:1.5;color:var(--text)">${escHtml(task.title || '')}</div>
        <div style="margin-top:10px;font-size:12px;color:var(--muted)">${escHtml(task.id)} · ${escHtml(task.status || '')} · ${escHtml(task.priority || '')}</div>
      `;
    }

    renderActionBar(task);
    await loadActivity(taskId);
    _startPolling(taskId);
  } catch (err) {
    toast('Fehler beim Laden: ' + err.message, 'danger');
    closeTaskDetail();
  }
}

export function closeTaskDetail() {
  _stopPolling();
  detailState.activeTaskId = null;
  detailState._task = null;
  const panel = document.getElementById('taskDetailPanel');
  const overlay = document.querySelector('.board-overlay');

  panel.classList.add('hide');
  if (overlay) overlay.classList.remove('active');
}

function _startPolling(taskId) {
  _pollInterval = setInterval(() => {
    if (detailState.activeTaskId === taskId) {
      loadActivity(taskId);
    } else {
      _stopPolling();
    }
  }, 12000);
}

function _stopPolling() {
  if (_pollInterval !== null) {
    clearInterval(_pollInterval);
    _pollInterval = null;
  }
}

async function fetchTask(taskId) {
  const data = await api(`/projects/${detailState.activeProject}/tasks`);
  const tasks = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
  return tasks.find(t => t.id === taskId) || null;
}

// ─── Action Bar ────────────────────────────────────────────

/**
 * Visibility matrix for action bar buttons.
 * Returns which buttons to show and their enabled state.
 */
function getActionBarState(task) {
  if (!task) return null;

  const s = task.status;
  const isClaimed = !!task.agent;
  const isBlocked = !!task.blocked;
  const hasSubtasks = task.subtaskIds && task.subtaskIds.length > 0;

  // Statuses where coordination actions make sense
  const isActive = s === 'open' || s === 'in-progress' || s === 'ready';
  const isCompletable = s === 'open' || s === 'in-progress';
  const isBlockable = s === 'open' || s === 'in-progress' || s === 'review';

  return {
    claim: {
      show: isActive && !isClaimed && !hasSubtasks,
      label: 'Claim'
    },
    release: {
      show: isClaimed && s !== 'done' && s !== 'archived',
      label: 'Release'
    },
    complete: {
      show: isCompletable && !isBlocked,
      enabled: !hasSubtasks || _allSubtasksDone(task),
      label: 'Complete → Review'
    },
    blocked: {
      show: isBlockable,
      label: isBlocked ? 'Unblock' : 'Block',
      isBlocked
    }
  };
}

// Uses kanban cache (refreshed every 5s) — acceptable staleness for UI gating
function _allSubtasksDone(task) {
  if (!task.subtaskIds || task.subtaskIds.length === 0) return true;
  const allTasks = window.appState?.tasks || [];
  return task.subtaskIds.every(id => {
    const sub = allTasks.find(t => t.id === id);
    return sub && (sub.status === 'done' || sub.status === 'archived');
  });
}

function renderActionBar(task) {
  const container = document.getElementById('detailActions');
  if (!container) return;

  if (!task || !detailState._hzlAvailable) {
    container.innerHTML = '';
    container.classList.add('hide');
    return;
  }

  const bar = getActionBarState(task);
  if (!bar) {
    container.innerHTML = '';
    container.classList.add('hide');
    return;
  }

  const buttons = [];

  if (bar.claim.show) {
    buttons.push(`<button class="detail-action-btn action-claim" data-action="detail-claim" title="Claim this task">${bar.claim.label}</button>`);
  }
  if (bar.release.show) {
    buttons.push(`<button class="detail-action-btn action-release" data-action="detail-release" title="Release claim on this task">${bar.release.label}</button>`);
  }
  if (bar.complete.show) {
    const dis = bar.complete.enabled === false ? ' disabled title="All subtasks must be done first"' : ' title="Mark complete and move to review"';
    buttons.push(`<button class="detail-action-btn action-complete" data-action="detail-complete"${dis}>${bar.complete.label}</button>`);
  }
  if (bar.blocked.show) {
    const cls = bar.blocked.isBlocked ? ' is-active' : '';
    buttons.push(`<button class="detail-action-btn action-blocked${cls}" data-action="detail-toggle-blocked" title="${bar.blocked.isBlocked ? 'Remove blocked flag' : 'Flag as blocked'}">${bar.blocked.label}</button>`);
  }

  if (buttons.length === 0) {
    container.innerHTML = '';
    container.classList.add('hide');
    return;
  }

  container.innerHTML = buttons.join('');
  container.classList.remove('hide');
}

// ─── Action Handlers ───────────────────────────────────────

async function handleClaim() {
  const task = detailState._task;
  if (!task) return;
  const proj = detailState.activeProject;

  // Optimistic update
  const agent = _currentAgent();
  const oldAgent = task.agent;
  const oldStatus = task.status;
  task.agent = agent;
  if (task.status === 'open' || task.status === 'ready') task.status = 'in-progress';
  renderActionBar(task);

  try {
    const res = await api(`/projects/${proj}/tasks/${task.id}/claim`, {
      method: 'POST',
      body: { agent, lease: 60 }
    });
    if (res?.error) throw new Error(res.error);

    // Sync known fields from server response (avoid blind Object.assign)
    if (res.task) {
      task.status = res.task.status ?? task.status;
      task.agent = res.task.agent ?? task.agent;
      task.blocked = res.task.blocked ?? task.blocked;
      task.previousStatus = res.task.previousStatus ?? task.previousStatus;
    }
    detailState._task = task;
    renderActionBar(task);
    _refreshKanban();
    _addSyntheticFeedItem('status', `Task claimed by ${agent}`);
    toast('Task claimed', 'success');
  } catch (err) {
    // Revert
    task.agent = oldAgent;
    task.status = oldStatus;
    renderActionBar(task);
    if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
      detailState._hzlAvailable = false;
      renderActionBar(null);
    }
    toast('Claim failed: ' + (err.message || 'Unknown error'), 'error');
  }
}

async function handleRelease() {
  const task = detailState._task;
  if (!task) return;
  const proj = detailState.activeProject;

  const agent = _currentAgent();
  const oldAgent = task.agent;
  const oldStatus = task.status;
  task.agent = null;
  task.status = task.previousStatus || 'open';
  renderActionBar(task);

  try {
    const res = await api(`/projects/${proj}/tasks/${task.id}/release`, {
      method: 'POST',
      body: { agent, force: true }
    });
    if (res?.error) throw new Error(res.error);

    // Re-fetch to get accurate status (release restores previousStatus)
    const fresh = await fetchTask(task.id);
    if (fresh) {
      detailState._task = fresh;
      renderActionBar(fresh);
      _updateDetailMeta(fresh);
    }
    _refreshKanban();
    _addSyntheticFeedItem('status', 'Task released');
    toast('Task released', 'success');
  } catch (err) {
    task.agent = oldAgent;
    task.status = oldStatus;
    renderActionBar(task);
    if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
      detailState._hzlAvailable = false;
      renderActionBar(null);
    }
    toast('Release failed: ' + (err.message || 'Unknown error'), 'error');
  }
}

async function handleComplete() {
  const task = detailState._task;
  if (!task) return;
  const proj = detailState.activeProject;

  const oldStatus = task.status;
  const oldAgent = task.agent;
  const oldCompleted = task.completed;
  task.status = 'review';
  task.agent = null;
  task.completed = new Date().toISOString().slice(0, 10);
  renderActionBar(task);

  try {
    // Complete requires agent; prefer current claim, fallback to session user
    const agent = oldAgent || _currentAgent();
    const res = await api(`/projects/${proj}/tasks/${task.id}/complete`, {
      method: 'POST',
      body: { agent }
    });
    if (res?.error) throw new Error(res.error);

    // Sync known fields from server response (avoid blind Object.assign)
    if (res.task) {
      task.status = res.task.status ?? task.status;
      task.agent = res.task.agent ?? task.agent;
      task.blocked = res.task.blocked ?? task.blocked;
      task.completed = res.task.completed ?? task.completed;
      task.previousStatus = res.task.previousStatus ?? task.previousStatus;
    }
    detailState._task = task;
    renderActionBar(task);
    _updateDetailMeta(task);
    _refreshKanban();
    _addSyntheticFeedItem('status', 'Task completed → Review');
    toast('Task moved to Review', 'success');
  } catch (err) {
    task.status = oldStatus;
    task.agent = oldAgent;
    task.completed = oldCompleted;
    renderActionBar(task);
    if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
      detailState._hzlAvailable = false;
      renderActionBar(null);
    }
    toast('Complete failed: ' + (err.message || 'Unknown error'), 'error');
  }
}

async function handleToggleBlocked() {
  const task = detailState._task;
  if (!task) return;
  const proj = detailState.activeProject;

  const oldBlocked = task.blocked;
  task.blocked = !task.blocked;
  renderActionBar(task);

  try {
    const res = await api(`/projects/${proj}/tasks/${task.id}`, {
      method: 'PUT',
      body: { blocked: task.blocked }
    });
    if (res?.error && !res.ok) throw new Error(res.error || 'Update failed');

    detailState._task = task;
    renderActionBar(task);
    _updateDetailMeta(task);
    _refreshKanban();
    _addSyntheticFeedItem('status', task.blocked ? 'Task blocked' : 'Task unblocked');
    toast(task.blocked ? 'Task blocked' : 'Task unblocked', 'success');
  } catch (err) {
    task.blocked = oldBlocked;
    renderActionBar(task);
    if (err.message?.includes('503') || err.message?.includes('HZL not enabled')) {
      detailState._hzlAvailable = false;
      renderActionBar(null);
    }
    toast('Failed to update blocked status: ' + (err.message || 'Unknown error'), 'error');
  }
}

// ─── Helpers ───────────────────────────────────────────────

/** Update the meta line in the description section */
function _updateDetailMeta(task) {
  const descEl = document.getElementById('detailDescription');
  if (!descEl) return;
  descEl.innerHTML = `
    <div class="detail-section-title">Task</div>
    <div style="font-size:14px;line-height:1.5;color:var(--text)">${escHtml(task.title || '')}</div>
    <div style="margin-top:10px;font-size:12px;color:var(--muted)">${escHtml(task.id)} · ${escHtml(task.status || '')} · ${escHtml(task.priority || '')}</div>
  `;
}

/** Trigger kanban board refresh to reflect state changes */
function _refreshKanban() {
  if (window.appState?._refreshBoard) {
    window.appState._refreshBoard();
  }
}

/** Add a synthetic activity item to the feed (local only, no API) */
function _addSyntheticFeedItem(type, message) {
  const container = document.getElementById('activityFeed');
  if (!container) return;

  // Remove empty-state placeholder if present
  const empty = container.querySelector('.activity-empty');
  if (empty) empty.remove();

  const div = document.createElement('div');
  div.className = `activity-item item-${type}`;
  const time = fmtTime(new Date().toISOString());

  div.innerHTML = `
    <div class="activity-dot"></div>
    <div class="activity-meta">
      <span class="activity-icon">${ACTIVITY_ICON[type] || '→'}</span>
      <span class="activity-author">${escHtml(_currentAgent().toUpperCase())}</span>
      <span class="activity-time">${time}</span>
    </div>
    <div class="activity-body">${escHtml(message)}</div>
  `;
  container.appendChild(div);

  // Scroll feed to bottom
  const scroll = document.getElementById('detailScroll');
  if (scroll) scroll.scrollTop = scroll.scrollHeight;
}

// ─── Activity Feed ─────────────────────────────────────────

async function loadActivity(taskId) {
  const container = document.getElementById('activityFeed');

  const [commentsResult, checkpointsResult] = await Promise.allSettled([
    api(`/projects/${detailState.activeProject}/tasks/${taskId}/comments`),
    api(`/projects/${detailState.activeProject}/tasks/${taskId}/checkpoints`),
  ]);

  // Detect HZL unavailability from 503 responses
  if (commentsResult.status === 'rejected' || checkpointsResult.status === 'rejected') {
    const err = commentsResult.reason || checkpointsResult.reason;
    if (err?.message?.includes('503')) {
      detailState._hzlAvailable = false;
      renderActionBar(null);
    }
  }

  const comments = commentsResult.status === 'fulfilled'
    ? (Array.isArray(commentsResult.value?.comments) ? commentsResult.value.comments : [])
    : [];

  const checkpoints = checkpointsResult.status === 'fulfilled'
    ? (Array.isArray(checkpointsResult.value?.checkpoints) ? checkpointsResult.value.checkpoints : [])
    : [];

  const feed = [
    ...comments.map(c => ({ ...c, type: 'comment' })),
    ...checkpoints.map(c => ({ ...c, type: 'checkpoint' })),
  ].sort((a, b) => {
    const ta = a.timestamp ? new Date(a.timestamp).getTime() : 0;
    const tb = b.timestamp ? new Date(b.timestamp).getTime() : 0;
    return ta - tb;
  });

  renderActivity(feed, container);
}

const ACTIVITY_ICON = {
  comment: '💬',
  checkpoint: '✓',
  status: '→',
};

function renderActivity(items, container) {
  if (items.length === 0) {
    container.innerHTML = '<div class="activity-empty">📭 Noch keine Aktivität</div>';
    return;
  }

  container.innerHTML = '';
  items.forEach(item => {
    const div = document.createElement('div');
    div.className = `activity-item item-${item.type || 'comment'}`;

    const icon = ACTIVITY_ICON[item.type] || '·';
    const author = escHtml(item.author || item.agent || 'System');
    const time = fmtTime(item.timestamp);

    div.innerHTML = `
      <div class="activity-dot"></div>
      <div class="activity-meta">
        <span class="activity-icon">${icon}</span>
        <span class="activity-author">${author}</span>
        <span class="activity-time">${time}</span>
      </div>
      <div class="activity-body">${escHtml(item.message || '')}</div>
    `;
    container.appendChild(div);
  });
}

async function submitComment() {
  const input = document.getElementById('commentText');
  const text = input.value.trim();
  if (!text || !detailState.activeTaskId) return;

  const btn = document.getElementById('sendComment');
  btn.disabled = true;

  try {
    const result = await api(`/projects/${detailState.activeProject}/tasks/${detailState.activeTaskId}/comment`, {
      method: 'POST',
      body: {
        message: text,
        author: _currentAgent()
      }
    });

    if (!result?.error) {
      input.value = '';
      toast('Kommentar gesendet', 'success');
      loadActivity(detailState.activeTaskId);
    } else {
      toast('Senden fehlgeschlagen', 'danger');
    }
  } catch (err) {
    toast('Netzwerkfehler', 'danger');
  } finally {
    btn.disabled = false;
  }
}

function createOverlay() {
  const div = document.createElement('div');
  div.className = 'board-overlay';
  div.style.cssText = `
    position: fixed; top: 0; left: 0; width: 100%; height: 100%;
    background: rgba(0,0,0,0.5); z-index: 1500;
    opacity: 0; transition: opacity 0.3s; pointer-events: none;
    backdrop-filter: blur(2px);
  `;
  document.body.appendChild(div);

  div.onclick = closeTaskDetail;

  // Dynamic CSS addition for .active
  const style = document.createElement('style');
  style.textContent = '.board-overlay.active { opacity: 1; pointer-events: auto; }';
  document.head.appendChild(style);

  return div;
}
