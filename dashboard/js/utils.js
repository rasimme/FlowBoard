// utils.js — legacy Idea Canvas API calls & helpers.
//
// React-owned dashboard code uses src/utils/* and the ADR-0019 task runtime.
// Keep this module scoped to dashboard/js/canvas/* until ADR-0012 is revisited.

// Always use relative URLs — works for direct access (port 18790),
// SSH tunnels, and Cloudflare Tunnel (HTTPS proxy)
export const API_HOST = '';
export const API = API_HOST + '/api';

export const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
export const PRIORITY_CYCLE = { low: 'medium', medium: 'high', high: 'low' };
export const STATUS_KEYS = ['backlog', 'open', 'in-progress', 'review', 'done'];
export const STATUS_LABELS = { 'backlog': 'Backlog', 'open': 'Open', 'in-progress': 'In Progress', 'review': 'Review', 'done': 'Done' };

// --- API Helper ---
export async function api(path, opts = {}) {
  const headers = { 'Content-Type': 'application/json', ...opts.headers };
  // Telegram WebApp auth — send initData on every request for tunnel/iframe auth
  const _tg = window.Telegram?.WebApp;
  if (_tg?.initData) headers['X-Telegram-Init-Data'] = _tg.initData;

  const res = await fetch(API + path, {
    ...opts,
    headers,
    credentials: 'include',
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (res.status === 403) {
    // Try to re-auth with Telegram initData before showing error
    const tg = window.Telegram?.WebApp;
    if (tg?.initData) {
      const reauth = await fetch('/api/auth', {
        method: 'POST',
        headers: { 'X-Telegram-Init-Data': tg.initData },
        credentials: 'include'
      });
      if (reauth.ok) {
        // Re-auth succeeded — retry original request
        const retry = await fetch(API + path, {
          ...opts,
          headers,
          credentials: 'include',
          body: opts.body ? JSON.stringify(opts.body) : undefined
        });
        if (retry.ok) return retry.json();
      }
    }
    document.getElementById('content').innerHTML = `
      <div class="empty-state" style="flex-direction:column;gap:12px">
        <span style="font-size:32px">🔒</span>
        <span>Session expired</span>
        <span style="font-size:12px;color:var(--muted)">Please reopen via Telegram.</span>
      </div>`;
    throw new Error('Unauthorized');
  }
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    console.warn('API error', res.status, path, data.error || '');
    return data;
  }
  return res.json();
}

// --- Toast (bottom-right) ---
export function toast(msg, type = 'info') {
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  document.getElementById('toastContainer').appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 200);
  }, 3000);
}

// --- Modal ---
export function showModal(title, body, onConfirm, confirmLabel = 'Delete', confirmClass = 'btn-danger', secondaryAction = null) {
  const root = document.getElementById('modalRoot');
  const secondaryBtn = secondaryAction
    ? `<button class="btn btn-ghost btn-sm" id="modalSecondary">${escHtml(secondaryAction.label)}</button>`
    : '';
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <div class="modal-title">${escHtml(title)}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" id="modalCancel">Cancel</button>
        ${secondaryBtn}
        <button class="btn ${confirmClass} btn-sm" id="modalConfirm">${escHtml(confirmLabel)}</button>
      </div>
    </div>
  </div>`;
  document.getElementById('modalCancel').onclick = closeModal;
  document.getElementById('modalConfirm').onclick = () => { onConfirm(); closeModal(); };
  if (secondaryAction) {
    document.getElementById('modalSecondary').onclick = () => { closeModal(); secondaryAction.onAction(); };
  }
  document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeModal();
  };
  document.addEventListener('keydown', modalKeyHandler);
}

export function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
  document.removeEventListener('keydown', modalKeyHandler);
}

function modalKeyHandler(e) {
  if (e.key === 'Escape') { closeModal(); return; }
  if (e.key === 'Enter') {
    e.preventDefault();
    document.getElementById('modalConfirm')?.click();
  }
}

// --- Shared UI Components ---
const ICONS = {
  trash: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 6h18"/><path d="M8 6V4a2 2 0 012-2h4a2 2 0 012 2v2"/><path d="M19 6l-1 14a2 2 0 01-2 2H8a2 2 0 01-2-2L5 6"/></svg>',
  lightbulb: '<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 18h6"/><path d="M10 22h4"/><path d="M12 2a7 7 0 00-4 12.7V17h8v-2.3A7 7 0 0012 2z"/></svg>',
  ban: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="m4.9 4.9 14.2 14.2"/></svg>',
  archive: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="M10 12h4"/></svg>',
  archiveRestore: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect width="20" height="5" x="2" y="3" rx="1"/><path d="M4 8v11a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8"/><path d="m9.5 17 2.5-2.5 2.5 2.5"/><path d="M12 14.5V12"/></svg>',
  alertTriangle: '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3ZM12 9v4M12 17h.01"/></svg>',
};

export { ICONS };

// --- Helpers ---
export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// Display name cache populated from API response (displayName field from PROJECT.md titles)
const _displayNames = {};

export function registerDisplayNames(projects) {
  for (const p of projects) {
    if (p.displayName) _displayNames[p.name] = p.displayName;
  }
}

export function formatDisplayName(name) {
  if (_displayNames[name]) return _displayNames[name];
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}
