/**
 * FlowBoard change detection for the OpenClaw Gateway (T-487-8, T-498).
 *
 * Everything here is plain logic over the adapter's own shapes: what a
 * Control UI connection is looking at, what a board looked like last time,
 * and what moved since. It deliberately imports nothing — not the feature
 * SDK, not the plugin entry — for two reasons. The SDK subpaths only exist on
 * OpenClaw 2026.9.2 and newer, so anything that imports them cannot be loaded
 * by FlowBoard's own test suite on the baseline host; and a poll whose diff
 * rule can only be exercised through a running Gateway is a poll whose diff
 * rule is never tested. `openclaw/feature-entry.js` wires these into the
 * plugin service; the rules live here.
 */

/** Bounded per-connection registries; the oldest entry is evicted first. */
export const MAX_TRACKED_CONNECTIONS = 64;

/** How often the background service re-reads the project list, while watched. */
export const POLL_INTERVAL_MS = 10_000;
/** How often a *focused* board is re-read. The tick runs at this rate. */
export const TASK_POLL_INTERVAL_MS = 5_000;
/** How many boards may be watched at once, most recently focused first. */
export const MAX_WATCHED_PROJECTS = 8;
/** Above this the diff is emitted without ids, meaning "refetch the list". */
export const MAX_CHANGED_IDS = 50;
/** One board page for the poll's own read; the contract's ceiling. */
const TASK_POLL_LIMIT = 500;

/**
 * Per-connection record of which project each open FlowBoard page is looking at.
 *
 * The change poll needs to know *what to watch*, and only the client knows
 * that. Unlike the identity registry this holds nothing privileged — a project
 * name the caller already passes to every read — so it is written straight
 * from `ui.focus` input. Two properties keep it honest: it is keyed by the
 * host-supplied `connId` (a page cannot set another page's focus) and it is
 * bounded, both in how many connections it remembers and in how many distinct
 * boards the poll will watch.
 *
 * "Most recent wins": re-focusing moves a connection to the end of the map, so
 * when more than MAX_WATCHED_PROJECTS boards are open the poll follows the
 * ones someone actually switched to last.
 */
export function createFocusRegistry(onChange) {
  const byConnection = new Map();
  const notify = () => {
    try {
      onChange?.();
    } catch {
      /* focus is a hint for the poller; never fail a request over it */
    }
  };
  return {
    remember(connId, project) {
      if (!connId) return false;
      const next = typeof project === 'string' && project ? project : null;
      const known = byConnection.has(connId);
      if (known && byConnection.get(connId) === next) return false;
      byConnection.delete(connId);
      byConnection.set(connId, next);
      while (byConnection.size > MAX_TRACKED_CONNECTIONS) {
        const oldest = byConnection.keys().next();
        if (oldest.done) break;
        byConnection.delete(oldest.value);
      }
      notify();
      return true;
    },
    forget(connId) {
      if (connId && byConnection.delete(connId)) notify();
    },
    /** Distinct focused projects, most recently focused first, bounded. */
    projects() {
      const out = [];
      const entries = [...byConnection.values()].reverse();
      for (const project of entries) {
        if (!project || out.includes(project)) continue;
        out.push(project);
        if (out.length >= MAX_WATCHED_PROJECTS) break;
      }
      return out;
    },
    get size() {
      return byConnection.size;
    },
  };
}

/** Field separator that cannot occur in any of the digested values. */
const DIGEST_SEPARATOR = '␟';

/**
 * Fingerprint one board: what has to move for a card to look different.
 *
 * Eight fields, and no more, because every extra field is a false positive
 * that wakes every open page: the lifecycle status and the work state (the
 * column and the chip), the blocking reason, the assignee, when the task
 * entered its status, the title, and the manual rank. Deliberately excluded
 * are the stuck indicator (FlowBoard re-stamps `updatedAt` on every
 * evaluation, so it would fire on a timer) and the lease, which expires on a
 * clock rather than on a change.
 */
export function taskDigest(tasks) {
  const digest = new Map();
  for (const task of Array.isArray(tasks) ? tasks : []) {
    if (!task || typeof task.id !== 'string' || !task.id) continue;
    digest.set(
      task.id,
      [
        task.status ?? '',
        task.workState ?? '',
        task.workStateDetails?.reason ?? '',
        task.agent ?? '',
        task.enteredStatusAt ?? '',
        task.title ?? '',
        task.order ?? '',
      ].join(DIGEST_SEPARATOR),
    );
  }
  return digest;
}

/**
 * What changed between two fingerprints of the same board.
 *
 * `ids` lists added, removed and changed tasks together: to a board they are
 * the same instruction — look at this card again. A diff larger than
 * MAX_CHANGED_IDS comes back as `null`, which the event turns into "no ids",
 * because past that point naming cards is less useful than refetching the
 * column, and a truncated list of ids would silently omit the rest.
 */
export function digestDiff(previous, next) {
  if (!(previous instanceof Map) || !(next instanceof Map)) return { changed: false, ids: [] };
  const ids = new Set();
  for (const [id, print] of next) {
    if (!previous.has(id) || previous.get(id) !== print) ids.add(id);
  }
  for (const id of previous.keys()) if (!next.has(id)) ids.add(id);
  if (ids.size === 0) return { changed: false, ids: [] };
  if (ids.size > MAX_CHANGED_IDS) return { changed: true, ids: null };
  return {
    changed: true,
    ids: [...ids].sort((a, b) => a.localeCompare(b, 'en', { numeric: true })),
  };
}

/**
 * Background change detection for `feature.watch` (T-487-8, extended in T-498).
 *
 * `feature.watch` refreshes on contract events and never polls, so an agent
 * moving a task to review has to reach the browser as an event. FlowBoard's
 * dashboard has no push channel into the Gateway, so the plugin polls it — but
 * cheaply, and only when it can matter. Two lanes share one timer:
 *
 *  - **The project lane** (every POLL_INTERVAL_MS): one `GET /api/projects`,
 *    answered from the dashboard's in-memory projection, fingerprinted per
 *    project as lifecycle status plus the review and blocked counts. It is
 *    what keeps the switcher and its badges live for *every* project.
 *  - **The board lane** (every tick): `GET /api/projects/:name/tasks` for the
 *    projects Control UI connections say they are looking at (`ui.focus`),
 *    never more than MAX_WATCHED_PROJECTS of them, diffed per task so the
 *    event can name the cards that moved.
 *
 * Both lanes run only while a Control UI client is registered, so an idle
 * Gateway makes no requests at all. Nothing is emitted on the first
 * observation of a board: the first fetch is the baseline, and a diff against
 * "nothing" would announce every card as changed.
 *
 * Cost, worst case: MAX_WATCHED_PROJECTS boards at TASK_POLL_INTERVAL_MS is
 * 96 requests/min plus 6 for the project lane. FlowBoard exempts loopback from
 * its lane limiter, so that budget is politeness rather than a cap — it still
 * stays well inside the 300/min read lane a non-loopback caller would get, and
 * the realistic case is one focused board (12/min).
 *
 * Known gap (project lane): a change that moves neither a project's lifecycle
 * status nor its review/blocked counts is invisible there. For the board an
 * operator is actually looking at, the board lane now covers exactly that
 * case — a retitled, reassigned or re-ordered task included.
 */
export function createChangePoller({
  adapter,
  events,
  hasClients,
  watchedProjects = () => [],
  logger,
  intervalMs = TASK_POLL_INTERVAL_MS,
  projectsIntervalMs = POLL_INTERVAL_MS,
}) {
  let timer = null;
  let enabled = false;
  let busy = false;
  let previous = null;
  let failures = 0;
  let lastProjectsAt = 0;
  /** project name -> last seen task fingerprint. Dropped when focus moves off. */
  const boards = new Map();

  const fingerprint = (projects) =>
    new Map(projects.map((project) => [project.name, `${project.status}|${project.counts.review}|${project.counts.blocked}`]));

  const reset = () => {
    previous = null;
    lastProjectsAt = 0;
    boards.clear();
    failures = 0;
  };

  /**
   * One line per outage, not one per tick.
   *
   * `failures` only returns to zero on a tick where nothing failed, so a
   * board that stays unreadable is reported once and then stays quiet — the
   * counter cannot be reset by the healthy half of the same tick.
   */
  let failedThisTick = false;
  const noteFailure = (error) => {
    failedThisTick = true;
    failures += 1;
    if (failures === 1) {
      logger?.debug?.(`[flowboard] change poll paused: ${String(error?.message || error).slice(0, 200)}`);
    }
  };

  async function pollProjects() {
    // No principal: this read belongs to the Gateway's own bookkeeping, not
    // to any signed-in operator, so it carries no profile headers.
    const next = fingerprint(await adapter.listProjects(null));
    if (previous) {
      let membershipChanged = false;
      for (const [name, print] of next) {
        if (!previous.has(name)) membershipChanged = true;
        else if (previous.get(name) !== print) events.emit('tasks-changed', { project: name });
      }
      for (const name of previous.keys()) if (!next.has(name)) membershipChanged = true;
      if (membershipChanged) events.emit('projects-changed', {});
    }
    previous = next;
  }

  async function pollBoards() {
    const watched = watchedProjects();
    // Focus moved: a board nobody is looking at keeps no baseline, so coming
    // back to it starts from a fresh fetch instead of replaying an old diff.
    for (const name of [...boards.keys()]) if (!watched.includes(name)) boards.delete(name);

    for (const name of watched) {
      let next;
      try {
        const { tasks } = await adapter.listTasks(null, { project: name, limit: TASK_POLL_LIMIT });
        next = taskDigest(tasks);
      } catch (error) {
        // One unreadable board (deleted, renamed, still importing) must not
        // stop the others from being watched.
        boards.delete(name);
        noteFailure(error);
        continue;
      }
      const baseline = boards.get(name);
      boards.set(name, next);
      if (!baseline) continue;
      const diff = digestDiff(baseline, next);
      if (diff.changed) {
        events.emit('tasks-changed', { project: name, ...(diff.ids ? { ids: diff.ids } : {}) });
      }
    }
  }

  async function tick() {
    if (!enabled || busy) return;
    if (!hasClients()) {
      // Nobody is watching: forget every baseline so the next client starts
      // from its own fresh fetch instead of a replayed diff.
      reset();
      return;
    }
    busy = true;
    failedThisTick = false;
    try {
      const now = Date.now();
      if (now - lastProjectsAt >= projectsIntervalMs) {
        lastProjectsAt = now;
        await pollProjects();
      }
      await pollBoards();
      if (!failedThisTick) failures = 0;
    } catch (error) {
      previous = null;
      noteFailure(error);
    } finally {
      busy = false;
    }
  }

  return {
    start() {
      if (timer) return;
      enabled = true;
      timer = setInterval(() => void tick(), intervalMs);
      timer.unref?.();
      logger?.debug?.(
        `[flowboard] change poll armed (${intervalMs} ms, only while a Control UI client is connected)`,
      );
    },
    stop() {
      enabled = false;
      reset();
      if (timer) clearInterval(timer);
      timer = null;
    },
    /** Prime immediately when the first client arrives or the focus moves. */
    wake() {
      if (enabled) void tick();
    },
    get running() {
      return Boolean(timer);
    },
    /** Test seam: run one tick synchronously instead of waiting for the timer. */
    tick,
  };
}
