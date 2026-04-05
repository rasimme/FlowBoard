// detail.js — Task Detail Slide-over Panel

import { api, toast, escHtml, STATUS_LABELS } from './utils.js?v=9';

export const detailState = {
  activeTaskId: null,
  activeProject: null
};

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
}

export async function openTaskDetail(taskId) {
  detailState.activeTaskId = taskId;
  _stopPolling();

  const panel = document.getElementById('taskDetailPanel');
  const overlay = document.querySelector('.board-overlay') || createOverlay();

  panel.classList.remove('hide');
  overlay.classList.add('active');

  // Initial UI state
  document.getElementById('detailTaskId').textContent = taskId;
  document.getElementById('detailTitle').textContent = 'Lade...';
  document.getElementById('activityFeed').innerHTML = '<div class="activity-loading">Daten werden geladen…</div>';

  try {
    const task = await fetchTask(taskId);
    if (!task) throw new Error('Task nicht gefunden');

    document.getElementById('detailTitle').textContent = task.title;
    const descEl = document.getElementById('detailDescription');
    if (descEl) {
      descEl.innerHTML = `
        <div class="detail-section-title">Task</div>
        <div style="font-size:14px;line-height:1.5;color:var(--text)">${escHtml(task.title || '')}</div>
        <div style="margin-top:10px;font-size:12px;color:var(--muted)">${escHtml(task.id)} · ${escHtml(task.status || '')} · ${escHtml(task.priority || '')}</div>
      `;
    }

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

async function loadActivity(taskId) {
  const container = document.getElementById('activityFeed');

  const [commentsResult, checkpointsResult] = await Promise.allSettled([
    api(`/projects/${detailState.activeProject}/tasks/${taskId}/comments`),
    api(`/projects/${detailState.activeProject}/tasks/${taskId}/checkpoints`),
  ]);

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
        author: 'simeon'
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
