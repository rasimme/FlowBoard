/**
 * The dashboard's shell: the static frame (`.app`, sidebar, tab bar, content,
 * toast and modal roots) the React tree portals into.
 *
 * Standalone, that frame is the markup in index.html and lookups go through
 * `document`. When the dashboard is mounted inside a host page (T-515-2) the
 * mount builds the frame inside its own root and registers it here, so lookups
 * stay inside FlowBoard's subtree and never match a host element that happens
 * to share an id or class.
 */
let shellRoot = null;
let hostChrome = false;

/** Register (or clear) the mount root. `hostChrome`: the host supplies the page header. */
export function setShell(root, options = {}) {
  shellRoot = root || null;
  hostChrome = Boolean(root && options.hostChrome);
}

/** True when a host page frames the dashboard and FlowBoard's own header is omitted. */
export function usesHostChrome() {
  return hostChrome;
}

/** First match inside the shell (or the document when standalone). */
export function shellQuery(selector) {
  return (shellRoot?.isConnected ? shellRoot : document).querySelector(selector);
}

/** The static frame, shared by index.html's markup and a host mount. */
export function buildShell(root, { header = true } = {}) {
  root.innerHTML = `
<div class="app" id="app">
  <div class="sidebar-backdrop"></div>
  ${header ? '<div class="header"></div>' : ''}
  <div class="tab-bar" id="tabBar"></div>
  <div class="sidebar" id="sidebar"></div>
  <div class="content" id="content"></div>
</div>
<div class="toast-container" id="toastContainer"></div>
<div id="modalRoot"></div>
<div id="react-root"></div>`;
  return root;
}
