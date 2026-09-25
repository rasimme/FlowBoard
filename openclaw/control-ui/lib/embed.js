/**
 * The framed single-surface views and the embed protocol, host side (T-499).
 *
 * Ideas, Files and Projects are the dashboard's own views, framed one at a
 * time without the dashboard's chrome (`?embed=<surface>`). Stage 1 framed the
 * whole SPA; that frame is retired. What replaces it is a small protocol
 * between this page and the framed surface (protocol v1, spec T-499):
 *
 *   frame → host   `ready`, `open-task`, `open-surface`, `open-project`,
 *                  `specify-closed`
 *   host  → frame  `context { surface, project, file? }`
 *
 * Every message is `{ type: 'flowboard:embed', v: 1, kind, ...payload }`.
 * Three rules are enforced here, where they can be tested without a DOM:
 *
 *  1. **Only the frame may talk to us.** A message counts only when its
 *     `source` is the one iframe this page owns *and* its `origin` is the
 *     configured dashboard's origin. Anything else — another frame, a forged
 *     message from a page with a matching payload, a dashboard on another
 *     host — is dropped silently.
 *  2. **Payloads are identifiers, never markup or URLs.** Every field a frame
 *     sends is bounded and pattern-checked before the page acts on it, so a
 *     compromised or merely buggy frame can at most select a project or task
 *     by name.
 *  3. **The frame is loaded once and steered afterwards.** Switching project
 *     or surface posts `context` to a frame that said `ready`; only a frame
 *     that never answered is re-pointed (`src`), because that is what an older
 *     dashboard without embed mode — or one that cannot be framed at all —
 *     looks like. After READY_TIMEOUT_MS without `ready` the page shows a
 *     notice with a link to the full dashboard instead of an empty box.
 */

/*
 * The same identifier rule as deep-link.js `boundedParam` (project names and
 * task ids). Repeated rather than imported: the lib modules stay import-free
 * so they load in the unit tests without a bundler (test-plugin-entry-compat).
 */
function boundedParam(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > 128) return null;
  return /^[A-Za-z0-9][A-Za-z0-9._:-]*$/u.test(text) ? text : null;
}

export const EMBED_MESSAGE_TYPE = 'flowboard:embed';
export const EMBED_PROTOCOL_VERSION = 1;
export const READY_TIMEOUT_MS = 8000;

/** Surfaces the dashboard serves in embed mode. `specify` is transient. */
export const EMBED_SURFACES = ['ideas', 'files', 'projects', 'specify'];

/** What a frame may ask the host to switch to; `tasks`/`board` mean the native board. */
const SURFACE_REQUESTS = { ideas: 'ideas', files: 'files', projects: 'projects', tasks: 'board', board: 'board' };

const FRAME_KINDS = new Set(['ready', 'open-task', 'open-surface', 'open-project', 'specify-closed']);

const MAX_FILE_LENGTH = 512;
const MAX_TITLE_LENGTH = 128;
const PRIORITIES = new Set(['low', 'medium', 'high']);

/** A workspace-relative file path: bounded, no control characters, no traversal. */
export function boundedFile(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > MAX_FILE_LENGTH) return null;
  if (/[\u0000-\u001f\u007f]/u.test(text)) return null;
  if (text.startsWith('/') || text.split(/[\\/]/u).includes('..')) return null;
  return text;
}

function boundedTitle(value) {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ').trim();
  if (!text) return null;
  return text.slice(0, MAX_TITLE_LENGTH);
}

/** The origin of the configured dashboard, or '' when it is not a URL. */
export function dashboardOrigin(dashboardUrl) {
  try {
    return new URL(dashboardUrl).origin;
  } catch {
    return '';
  }
}

/**
 * The URL of one framed surface.
 *
 * `host` is the Control UI's own origin: the dashboard only answers (and only
 * posts to) that origin, after checking it against its frame-ancestors list.
 * An unknown surface or an unusable dashboard URL yields '' — the caller then
 * frames nothing rather than the whole SPA.
 */
export function buildEmbedUrl(dashboardUrl, { surface, project, task, file, title, priority, host } = {}) {
  if (typeof dashboardUrl !== 'string' || !dashboardUrl) return '';
  if (!EMBED_SURFACES.includes(surface)) return '';
  let url;
  try {
    url = new URL(dashboardUrl);
  } catch {
    return '';
  }
  url.searchParams.set('embed', surface);
  const name = boundedParam(project);
  if (name) url.searchParams.set('project', name);
  const id = name ? boundedParam(task) : null;
  if (id) url.searchParams.set('task', id);
  const path = surface === 'files' ? boundedFile(file) : null;
  if (path) url.searchParams.set('file', path);
  if (surface === 'specify') {
    const text = boundedTitle(title);
    if (text) url.searchParams.set('title', text);
    if (PRIORITIES.has(priority)) url.searchParams.set('priority', priority);
  }
  const origin = typeof host === 'string' ? dashboardOrigin(host) : '';
  if (origin) url.searchParams.set('host', origin);
  return url.toString();
}

/**
 * Validate one `message` event. Returns the sanitized message, or null when
 * it is not ours to act on. `expectedSource` is the iframe's `contentWindow`;
 * `expectedOrigin` the dashboard origin.
 */
export function parseFrameMessage(event, { expectedSource, expectedOrigin } = {}) {
  if (!event || !expectedSource || !expectedOrigin) return null;
  if (event.source !== expectedSource) return null;
  if (event.origin !== expectedOrigin) return null;
  const data = event.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  if (data.type !== EMBED_MESSAGE_TYPE || data.v !== EMBED_PROTOCOL_VERSION) return null;
  if (!FRAME_KINDS.has(data.kind)) return null;
  switch (data.kind) {
    case 'ready':
      return { kind: 'ready', surface: EMBED_SURFACES.includes(data.surface) ? data.surface : null };
    case 'open-task': {
      const project = boundedParam(data.project);
      const task = boundedParam(data.task ?? data.id);
      if (!task) return null;
      return { kind: 'open-task', project, task };
    }
    case 'open-surface': {
      const surface = SURFACE_REQUESTS[data.surface];
      if (!surface) return null;
      return {
        kind: 'open-surface',
        surface,
        project: boundedParam(data.project),
        file: surface === 'files' ? boundedFile(data.file) : null,
      };
    }
    case 'open-project': {
      const project = boundedParam(data.project);
      return project ? { kind: 'open-project', project } : null;
    }
    case 'specify-closed':
      return {
        kind: 'specify-closed',
        project: boundedParam(data.project),
        // The dashboard reports `{ completed, tasks: [ids] }`; the first
        // created task is the one to open.
        task: boundedParam(data.task ?? data.id ?? (Array.isArray(data.tasks) ? data.tasks[0] : undefined)),
      };
    default:
      return null;
  }
}

/** The one message the host sends: where the frame should be. */
export function contextMessage({ surface, project, file } = {}) {
  const message = {
    type: EMBED_MESSAGE_TYPE,
    v: EMBED_PROTOCOL_VERSION,
    kind: 'context',
    surface,
    project: boundedParam(project),
  };
  const path = surface === 'files' ? boundedFile(file) : null;
  if (path) message.file = path;
  return message;
}

/* ----------------------------------------------------------- frame state */

export function initialFrameState() {
  return { phase: 'idle', token: 0, url: '', at: null };
}

function sameTarget(left, right) {
  if (!left || !right) return false;
  return (
    left.surface === right.surface &&
    (left.project || null) === (right.project || null) &&
    (left.file || null) === (right.file || null) &&
    (left.title || null) === (right.title || null) &&
    (left.priority || null) === (right.priority || null)
  );
}

/**
 * The frame's lifecycle: idle → loading → ready | timeout.
 *
 *  - `load`    the page assigned `src` for `target`; a new token starts the
 *              ready clock.
 *  - `posted`  a ready frame was told to move to `target`.
 *  - `ready`   the frame answered; a late answer after the timeout still
 *              clears the notice.
 *  - `timeout` the clock for `token` ran out without an answer. A timeout for
 *              an older load is ignored: re-pointing restarts the clock.
 */
export function frameReducer(state = initialFrameState(), action = {}) {
  switch (action.type) {
    case 'load':
      return { phase: 'loading', token: state.token + 1, url: action.url || '', at: action.target ?? null };
    case 'posted':
      return state.phase === 'ready' ? { ...state, at: action.target ?? state.at } : state;
    case 'ready':
      return state.phase === 'loading' || state.phase === 'timeout' ? { ...state, phase: 'ready' } : state;
    case 'timeout':
      return state.phase === 'loading' && action.token === state.token ? { ...state, phase: 'timeout' } : state;
    default:
      return state;
  }
}

/**
 * What to do so the frame shows `target` (`{ surface, project, file,
 * title?, priority? }`): `{ kind: 'none' }`, `{ kind: 'post', message }` or
 * `{ kind: 'load', url }`.
 *
 * Specify is always a fresh load (its title and priority are URL input, and
 * it is transient), and leaving it reloads the surface it replaced.
 */
export function planFrame(state, target, { dashboardUrl, host } = {}) {
  if (!target || !EMBED_SURFACES.includes(target.surface)) return { kind: 'none' };
  const load = () => {
    const url = buildEmbedUrl(dashboardUrl, { ...target, host });
    return url ? { kind: 'load', url } : { kind: 'none' };
  };
  if (state.phase === 'idle') return load();
  if (sameTarget(state.at, target)) return { kind: 'none' };
  if (target.surface === 'specify' || state.at?.surface === 'specify') return load();
  if (state.phase === 'ready') return { kind: 'post', message: contextMessage(target) };
  // Loaded but silent: an older dashboard ignores `context`, so the only way
  // to move it is the URL.
  return load();
}

/** True when the page should show the "did not answer" notice. */
export function showsTimeoutNotice(state) {
  return state?.phase === 'timeout';
}
