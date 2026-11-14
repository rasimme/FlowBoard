/**
 * Where overlays (dialogs, popovers, tooltips, toasts) are portalled.
 *
 * Standalone this is `#modalRoot` from index.html. When the dashboard is
 * mounted inside a host page (T-515-2) the mount supplies its own root, so
 * overlays stay inside FlowBoard's subtree and its scoped styles instead of
 * landing in the host's <body>.
 */
import { shellQuery } from './shell.js';

let portalRoot = null;

export function setPortalRoot(element) {
  portalRoot = element || null;
}

export function getPortalRoot() {
  if (portalRoot?.isConnected) return portalRoot;
  return shellQuery('#modalRoot') || document.body;
}

/**
 * Root for overlays that are portalled straight into <body> standalone
 * (popovers, tooltips, drag ghosts, side panels). Only a host mount redirects
 * them; the standalone DOM placement is unchanged.
 */
export function getOverlayRoot() {
  if (portalRoot?.isConnected) return portalRoot;
  return document.body;
}
