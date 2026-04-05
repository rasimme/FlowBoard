// detail.js — Task Detail Slide-over Panel

import { api, toast, escHtml, STATUS_LABELS } from './utils.js?v=9';

export const detailState = {
  activeTaskId: null,
  activeProject: null
};

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
  const panel = document.getElementById('taskDetailPanel');
  const overlay = document.querySelector('.board-overlay') || createOverlay();
  
  panel.classList.remove('hide');
  overlay.classList.add('active');
  
  // Initial UI state
  document.getElementById('detailTaskId').textContent = taskId;
  document.getElementById('detailTitle').textContent = 'Lade...';
  document.getElementById('activityFeed').innerHTML = '<div style="opacity:0.5;padding:24px">Daten werden geladen...</div>';

  try {
    // 1. Task Data (from current state if lucky, or fetch)
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

    // 2. Comments / Checkpoints (HZL Activity)
    loadActivity(taskId);
  } catch (err) {
    toast('Fehler beim Laden: ' + err.message, 'danger');
    closeTaskDetail();
  }
}

export function closeTaskDetail() {
  detailState.activeTaskId = null;
  const panel = document.getElementById('taskDetailPanel');
  const overlay = document.querySelector('.board-overlay');
  
  panel.classList.add('hide');
  if (overlay) overlay.classList.remove('active');
}

async function fetchTask(taskId) {
  const data = await api(`/projects/${detailState.activeProject}/tasks`);
  const tasks = Array.isArray(data) ? data : Array.isArray(data?.tasks) ? data.tasks : [];
  return tasks.find(t => t.id === taskId) || null;
}

async function loadActivity(taskId) {
  const container = document.getElementById('activityFeed');
  
  try {
    // Current T-128 API returns checkpoints in task metadata OR separate endpoint
    // Let's assume GET /api/projects/:name/tasks/:id/comments in Phase 5
    const data = await api(`/projects/${detailState.activeProject}/tasks/${taskId}/comments`);
    const comments = Array.isArray(data?.comments) ? data.comments : Array.isArray(data) ? data : [];
    
    if (comments.length > 0) {
      renderActivity(comments, container);
    } else {
      container.innerHTML = '<div style="opacity:0.3;padding:24px;text-align:center">Keine Aktivitäten bisher.</div>';
    }
  } catch (err) {
    container.innerHTML = '<div style="opacity:0.5;padding:24px;color:var(--danger)">Fehler beim Laden des Feeds.</div>';
  }
}

function renderActivity(comments, container) {
  container.innerHTML = '';
  
  comments.forEach(item => {
    const div = document.createElement('div');
    div.className = `activity-item item-${item.type || 'comment'}`;
    
    const time = item.timestamp ? new Date(item.timestamp).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'}) : '--:--';
    const date = item.timestamp ? new Date(item.timestamp).toLocaleDateString() : '';

    div.innerHTML = `
      <div class="activity-dot"></div>
      <div class="activity-meta">
        <span class="activity-author">${escHtml(item.author || item.agent || 'System')}</span>
        <span class="activity-time">${date} ${time}</span>
      </div>
      <div class="activity-body">
        ${escHtml(item.message)}
      </div>
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
