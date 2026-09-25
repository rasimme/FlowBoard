// T-499 F1 — dashboard embed mode, pure core (no DOM, no fetch).
//
// A framing host (the OpenClaw Control UI) loads a single dashboard surface:
//
//   /?embed=<ideas|files|projects|specify>&project=<p>[&task=<id>][&file=<path>]
//     [&title=<t>&priority=<p>]&host=<host origin>
//
// Embed mode is active only when ALL of these hold; otherwise the dashboard
// runs its normal standalone code path:
//   - `embed` names a known surface,
//   - the page is framed (window.top !== window.self),
//   - `host` is an absolute http(s) origin that the server allow-listed
//     (FLOWBOARD_FRAME_ANCESTORS, injected as window.__FLOWBOARD_FRAME_ANCESTORS__),
//   - where the browser exposes location.ancestorOrigins, its first entry
//     (the direct parent) equals that origin.
//
// Protocol v1 — every message is { type: 'flowboard:embed', v: 1, kind, ... }:
//   frame -> host: ready { surface, project? }, open-task { project, task },
//                  open-surface { surface, project?, file? },
//                  open-project { project }, specify-closed { project?, task? }
//   host -> frame: context { surface, project?, file? }
// Both sides check event.source and event.origin; the frame posts with the
// exact host origin as targetOrigin, never '*'.

export const MESSAGE_TYPE = 'flowboard:embed';
export const PROTOCOL_VERSION = 1;

/** Surfaces the frame can render (the `embed` param / context.surface). */
export const EMBED_SURFACES = Object.freeze(['ideas', 'files', 'projects', 'specify']);
/** Surfaces the frame can ask the host to open (open-surface.surface). */
export const HOST_SURFACES = Object.freeze(['board', 'ideas', 'files', 'projects']);
export const PRIORITIES = Object.freeze(['low', 'medium', 'high']);

export const MAX_PROJECT_LENGTH = 100;
export const MAX_TASK_ID_LENGTH = 80;
export const MAX_FILE_LENGTH = 512;
export const MAX_TITLE_LENGTH = 128; // same bound as the dashboard's New Task input

const PROJECT_RE = /^[A-Za-z0-9_-]+$/;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
// eslint-disable-next-line no-control-regex
const CONTROL_RE = /[\u0000-\u001f\u007f]/;

export function normalizeProject(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_PROJECT_LENGTH || !PROJECT_RE.test(value)) return null;
  return value;
}

export function normalizeTaskId(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_TASK_ID_LENGTH || !TASK_ID_RE.test(value)) return null;
  return value;
}

/** Project-relative file path: no absolute paths, backslashes, `..` or control chars. */
export function normalizeFilePath(value) {
  if (typeof value !== 'string') return null;
  if (!value || value.length > MAX_FILE_LENGTH) return null;
  if (value.startsWith('/') || value.includes('\\') || CONTROL_RE.test(value)) return null;
  const segments = value.split('/');
  if (segments.some((s) => s === '' || s === '.' || s === '..')) return null;
  return value;
}

export function normalizeTitle(value) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').trim(); // eslint-disable-line no-control-regex
  return cleaned.slice(0, MAX_TITLE_LENGTH);
}

export function normalizePriority(value) {
  return PRIORITIES.includes(value) ? value : 'medium';
}

/**
 * Parse one allow-list entry to a canonical origin, or null. Mirrors the
 * server's FLOWBOARD_FRAME_ANCESTORS parsing (absolute http(s), no
 * credentials, path, query or fragment).
 */
export function normalizeOrigin(value) {
  if (typeof value !== 'string' || !value || value.length > 2048) return null;
  let url;
  try { url = new URL(value); } catch { return null; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  if (url.username || url.password || url.search || url.hash) return null;
  if (url.pathname !== '' && url.pathname !== '/') return null;
  return url.origin;
}

export function readAllowList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
  for (const entry of value) {
    const origin = normalizeOrigin(entry);
    if (origin && !out.includes(origin)) out.push(origin);
  }
  return out;
}

/**
 * Verify the requested host origin. Returns the canonical origin or null.
 * `ancestorOrigins` is location.ancestorOrigins (array-like) or null where the
 * browser does not expose it (Firefox) — then the allow-list alone decides,
 * and every inbound message is still origin-checked.
 */
export function verifyHostOrigin(hostParam, { allowList = [], ancestorOrigins = null } = {}) {
  const origin = normalizeOrigin(hostParam);
  if (!origin) return null;
  if (!readAllowList(allowList).includes(origin)) return null;
  if (ancestorOrigins && typeof ancestorOrigins.length === 'number' && ancestorOrigins.length > 0) {
    if (ancestorOrigins[0] !== origin) return null;
  }
  return origin;
}

/**
 * Resolve embed mode from the page URL + environment. Returns null (standalone)
 * or a frozen config object.
 */
export function resolveEmbedConfig(search, { isFramed = false, allowList = [], ancestorOrigins = null } = {}) {
  if (!isFramed) return null;
  let params;
  try { params = new URLSearchParams(search || ''); } catch { return null; }
  const surface = params.get('embed');
  if (!EMBED_SURFACES.includes(surface)) return null;
  const hostOrigin = verifyHostOrigin(params.get('host'), { allowList, ancestorOrigins });
  if (!hostOrigin) return null;
  return Object.freeze({
    surface,
    hostOrigin,
    project: normalizeProject(params.get('project')),
    task: normalizeTaskId(params.get('task')),
    file: normalizeFilePath(params.get('file')),
    title: normalizeTitle(params.get('title')),
    priority: normalizePriority(params.get('priority')),
  });
}

/** Dashboard tab a surface renders through ViewShell (null = no ViewShell). */
export function surfaceTab(surface) {
  return surface === 'ideas' || surface === 'files' ? surface : null;
}

/** Host surface a dashboard tab maps to (null = no host equivalent). */
export function hostSurfaceForTab(tab) {
  if (tab === 'tasks') return 'board';
  if (tab === 'ideas' || tab === 'files') return tab;
  return null; // 'overview' stays standalone-only
}

// Optional `project` is omitted rather than sent as null.
function withProject(fields, project) {
  return project ? { ...fields, project } : fields;
}

function envelope(kind, fields) {
  return { type: MESSAGE_TYPE, v: PROTOCOL_VERSION, kind, ...fields };
}

/**
 * Build a validated frame -> host message, or null when the payload is out of
 * bounds (nothing is sent then).
 */
export function buildFrameMessage(kind, payload = {}) {
  const project = payload.project == null ? null : normalizeProject(payload.project);
  if (payload.project != null && !project) return null;
  switch (kind) {
    case 'ready': {
      if (!EMBED_SURFACES.includes(payload.surface)) return null;
      return envelope('ready', withProject({ surface: payload.surface }, project));
    }
    case 'open-task': {
      const task = normalizeTaskId(payload.task);
      if (!project || !task) return null;
      return envelope('open-task', { project, task });
    }
    case 'open-surface': {
      if (!HOST_SURFACES.includes(payload.surface)) return null;
      const msg = withProject({ surface: payload.surface }, project);
      if (payload.file != null) {
        const file = normalizeFilePath(payload.file);
        if (!file) return null;
        msg.file = file;
      }
      return envelope('open-surface', msg);
    }
    case 'open-project': {
      if (!project) return null;
      return envelope('open-project', { project });
    }
    case 'specify-closed': {
      // `task` = the first task the Specify run created; omitted when none.
      const msg = withProject({}, project);
      if (payload.task != null) {
        const task = normalizeTaskId(payload.task);
        if (!task) return null;
        msg.task = task;
      }
      return envelope('specify-closed', msg);
    }
    default:
      return null;
  }
}

/**
 * Strictly parse a host -> frame message. Only `context` is understood.
 * Returns { kind: 'context', surface, project, file } or null.
 */
export function parseHostMessage(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== MESSAGE_TYPE || data.v !== PROTOCOL_VERSION) return null;
  if (data.kind !== 'context') return null;
  if (!EMBED_SURFACES.includes(data.surface)) return null;
  let project = null;
  if (data.project != null) {
    project = normalizeProject(data.project);
    if (!project) return null;
  }
  let file = null;
  if (data.file != null) {
    file = normalizeFilePath(data.file);
    if (!file) return null;
  }
  return { kind: 'context', surface: data.surface, project, file };
}

/** Accept an inbound MessageEvent only from the verified parent + origin. */
export function isTrustedHostEvent(event, { parent, hostOrigin }) {
  if (!event || !hostOrigin || !parent) return false;
  return event.source === parent && event.origin === hostOrigin;
}

/**
 * Post a frame -> host message with the exact host origin as targetOrigin.
 * Returns the message sent, or null when nothing was sent.
 */
export function postToHost(target, hostOrigin, kind, payload) {
  if (!target || typeof target.postMessage !== 'function') return null;
  if (!normalizeOrigin(hostOrigin)) return null;
  const msg = buildFrameMessage(kind, payload);
  if (!msg) return null;
  target.postMessage(msg, hostOrigin);
  return msg;
}

/**
 * Collapse one synchronous burst of outbound messages: `open-task` already
 * implies the host's board, so a same-burst `open-surface {board}` (the
 * standalone "switch to Tasks, then scroll to task" pair) is dropped, and exact
 * duplicates are sent once.
 */
export function coalesceOutbound(batch) {
  const hasOpenTask = batch.some((m) => m.kind === 'open-task');
  const seen = new Set();
  const out = [];
  for (const m of batch) {
    if (hasOpenTask && m.kind === 'open-surface' && m.payload?.surface === 'board') continue;
    const key = JSON.stringify([m.kind, m.payload]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(m);
  }
  return out;
}
