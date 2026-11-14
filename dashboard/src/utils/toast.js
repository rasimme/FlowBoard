import { shellQuery } from './shell.js';
export function showToast(msg, type = 'info') {
  const container = shellQuery('#toastContainer');
  if (!container) return;
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  container.appendChild(el);
  setTimeout(() => {
    el.classList.add('removing');
    setTimeout(() => el.remove(), 200);
  }, 3000);
}

export function installGlobalToast() {
  window.showToast = showToast;
  return () => {
    if (window.showToast === showToast) delete window.showToast;
  };
}
