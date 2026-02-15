// utils.js — API calls & helpers

export const API_HOST = window.location.port === '18790'
  ? ''
  : `http://${window.location.hostname}:18790`;
export const API = API_HOST + '/api';

export const PRIORITY_ORDER = { high: 0, medium: 1, low: 2 };
export const PRIORITY_CYCLE = { low: 'medium', medium: 'high', high: 'low' };
export const STATUS_KEYS = ['open', 'in-progress', 'review', 'done'];
export const STATUS_LABELS = { 'open': 'Open', 'in-progress': 'In Progress', 'review': 'Review', 'done': 'Done' };

// --- API Helper ---
export async function api(path, opts = {}) {
  const res = await fetch(API + path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
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
export function showModal(title, body, onConfirm, confirmLabel = 'Delete', confirmClass = 'btn-danger') {
  const root = document.getElementById('modalRoot');
  root.innerHTML = `<div class="modal-overlay" id="modalOverlay">
    <div class="modal">
      <div class="modal-title">${title}</div>
      <div class="modal-body">${body}</div>
      <div class="modal-actions">
        <button class="btn btn-ghost btn-sm" id="modalCancel">Cancel</button>
        <button class="btn ${confirmClass} btn-sm" id="modalConfirm">${confirmLabel}</button>
      </div>
    </div>
  </div>`;
  document.getElementById('modalCancel').onclick = closeModal;
  document.getElementById('modalConfirm').onclick = () => { closeModal(); onConfirm(); };
  document.getElementById('modalOverlay').onclick = (e) => {
    if (e.target === e.currentTarget) closeModal();
  };
  document.addEventListener('keydown', modalEscHandler);
}

export function closeModal() {
  document.getElementById('modalRoot').innerHTML = '';
  document.removeEventListener('keydown', modalEscHandler);
}

function modalEscHandler(e) { if (e.key === 'Escape') closeModal(); }

// --- Helpers ---
export function escHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

export function formatDisplayName(name) {
  const brandedNames = {
    'flowboard': 'FlowBoard',
    'contextvault': 'ContextVault'
  };
  if (brandedNames[name]) return brandedNames[name];
  return name.split('-').map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');
}

export function formatSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
}

export function updateTimestamp() {
  const el = document.getElementById('lastRefresh');
  if (el) {
    el.textContent = new Date().toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  }
}
