/**
 * Project Context Hook — agent:bootstrap live-inject
 *
 * On every agent run, OpenClaw fires `agent:bootstrap` to assemble the
 * bootstrap-files array that gets injected into the model context. This
 * hook reads the canonical active-project state from the FlowBoard DB
 * (via the local API) and replaces the BOOTSTRAP.md entry in
 * `event.context.bootstrapFiles` with a live-built document containing
 * the active-project header, the agent's identity, the rules manifest,
 * live task state from the FlowBoard API, and task-neutral PROJECT.md
 * content.
 *
 * No on-disk writes. Single source of truth: flowboard_agents DB row.
 * Documented in specs/T-168-hook-lifecycle-coverage.md (T-168-3).
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || join(OPENCLAW_HOME, "projects");
const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const FLOWBOARD_REPO = process.env.FLOWBOARD_REPO || PACKAGE_ROOT;
const FLOWBOARD_PORT = process.env.FLOWBOARD_PORT || 18790;
const ALLOW_LEGACY_FILE_FALLBACK = process.env.FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK === "true";
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

// T-230: transient-failure resilience. The FlowBoard server is a launchd
// KeepAlive service, so unavailability is almost always a brief restart
// window. A single short attempt occasionally lands in that gap, surfacing a
// visible "failed" tool call and nudging the agent into improvising file
// scans. Retry a few times with short backoff to ride out the restart.
const FETCH_TIMEOUT_MS = Number(process.env.FLOWBOARD_HOOK_FETCH_TIMEOUT_MS) || 2000;
const FETCH_MAX_RETRIES = Number(process.env.FLOWBOARD_HOOK_FETCH_RETRIES) || 2; // extra attempts after the first
const FETCH_BACKOFF_MS = [150, 400, 800];

// Single source of truth for the rules manifest: load from the FlowBoard repo
// so the bootstrap manifest matches the server's. Fall back to an inline
// minimal manifest if the repo module can't be resolved.
const require = createRequire(import.meta.url);
let rulesApi = null;
try {
  rulesApi = require(join(FLOWBOARD_REPO, "dashboard", "rules-api.js"));
} catch (err) {
  console.warn(`[project-context] rules-api module unavailable (${err.message}); using inline manifest fallback`);
}

// Workspace → agentId convention:
//   ~/.openclaw/workspace            → "main"
//   ~/.openclaw/workspace-<id>       → "<id>"
function deriveAgentIdFromWorkspace(workspaceDir) {
  if (!workspaceDir) return null;
  const base = basename(workspaceDir);
  if (base === "workspace") return "main";
  if (base.startsWith("workspace-")) return base.slice("workspace-".length);
  return null;
}

function buildIdentitySection(agentId) {
  if (!agentId) return "";
  return [
    "## Identity",
    "",
    `Your \`agentId\` is: \`${agentId}\``,
    "",
    "Use this exact value in the `agent` / `agentId` field of every project /",
    "task API call. Never substitute a placeholder or guess a default — that",
    "silently routes your work into another agent's row in `flowboard_agents`",
    "and breaks attribution.",
    "",
  ].join("\n");
}

// Anti-inference header for the no-active-project case. The model
// otherwise tends to fill in a project name from conversation history,
// e.g. main erroneously announcing "Projekt flowboard ist weiterhin
// aktiv" after a gateway restart even though `flowboard_agents.active_project`
// for main is `null`. This header makes the absence explicit and load-bearing.
function buildNoActiveProjectSection() {
  return [
    "# No Active Project",
    "",
    "`flowboard_agents.active_project` is `null` for this agent. The single",
    "source of truth for the active project is the `# Active Project: <name>`",
    "header in this document — if no such header is present, there is no",
    "active project. Do **not** infer one from conversation history, recent",
    "topics, file paths in tool results, or anything else. To activate a",
    "project, the user must say so explicitly (e.g. `Project: <name>`); the",
    "agent then calls `PUT /api/status` and the next run sees the change.",
    "",
  ].join("\n");
}

// T-230: the status API was transiently unreachable (e.g. a brief KeepAlive
// restart window) AND no legacy fallback resolved a project. Unlike the
// authoritative null above, we must NOT assert "no active project" — that is a
// strong, misleading signal on a transient blip. Tell the agent the state is
// unknown, to retry, and to neither assume "none" nor guess one.
function buildProjectUnavailableSection(reason) {
  return [
    "# Active Project: Unknown (FlowBoard API temporarily unavailable)",
    "",
    `The FlowBoard status API could not be reached (${reason}). This is almost`,
    "always a brief restart window of the local service, **not** a sign that no",
    "project is active. Retry shortly: `GET /api/status?agentId=<agentId>`.",
    "",
    "Treat the active project as **unknown** until the API answers. Do **not**",
    "assume there is no active project, and do **not** infer one from",
    "conversation history, recent topics, or file paths in tool results.",
    "",
  ].join("\n");
}

function buildInlineManifestFallback() {
  return [
    "## Project Rules (lazy-load)",
    "",
    "Rule sections are served on demand. Request content via:",
    "`GET /api/projects/{project}/rules/{section}` — returns markdown.",
    "",
    "Available sections: `commands`, `api-access`, `hzl`, `canvas`, `files`, `specify`, `agent-bridge`, `error-handling`, `key-principles`.",
    "",
    "Legacy reference: `docs/project-mode/legacy/PROJECT-RULES.md` in the FlowBoard repo.",
  ].join("\n");
}

function buildRulesManifest() {
  return rulesApi ? rulesApi.buildRulesManifest() : buildInlineManifestFallback();
}

// T-230: fetch with retry + backoff. Retries thrown errors (connection
// refused during a restart) and 5xx responses (a still-starting server); a
// 4xx is a definitive answer and returned immediately. `fetchImpl`/`sleep`
// are injectable so the retry behaviour can be unit-tested without a server.
export async function fetchWithRetry(url, { fetchImpl = fetch, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  let lastErr = null;
  let lastRes = null;
  for (let attempt = 0; attempt <= FETCH_MAX_RETRIES; attempt++) {
    try {
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
      if (res.ok || res.status < 500) return res;
      lastRes = res; // 5xx → treat as transient and retry
    } catch (err) {
      lastErr = err;
    }
    if (attempt < FETCH_MAX_RETRIES) {
      await sleep(FETCH_BACKOFF_MS[attempt] ?? 800);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr;
}

// Discriminated result so callers can distinguish authoritative null
// (no project active) from a network failure.
async function resolveActiveProjectFromApi(agentId) {
  try {
    const url = `http://localhost:${FLOWBOARD_PORT}/api/status?agentId=${encodeURIComponent(agentId)}`;
    const res = await fetchWithRetry(url);
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, project: data.activeProject || null };
  } catch (err) {
    return { ok: false, reason: err?.message || "fetch failed" };
  }
}

// Legacy fallback is opt-in only. Reading ACTIVE-PROJECT.md on ordinary
// compaction/bootstrap paths can resurrect stale project state; DB/API is
// authoritative when FlowBoard is installed. Keep this for explicit migration
// windows by setting FLOWBOARD_ALLOW_ACTIVE_PROJECT_FILE_FALLBACK=true.
function resolveActiveProjectFromFile(workspaceDir) {
  if (!ALLOW_LEGACY_FILE_FALLBACK) return null;
  if (!workspaceDir) return null;
  const activeProjectPath = join(workspaceDir, "ACTIVE-PROJECT.md");
  if (!existsSync(activeProjectPath)) return null;
  try {
    const content = readFileSync(activeProjectPath, "utf8");
    const match = content.match(/^project:\s*(.+)$/m);
    const name = match?.[1]?.trim();
    return (name && name !== "none") ? name : null;
  } catch {
    return null;
  }
}

// T-230: render a transient task-state miss as a soft "retry, don't scan
// files" note rather than a hard BLOCKER, so a brief restart window does not
// push the agent into improvising file scans.
function buildTaskStateUnavailableMarkdown(url, reason) {
  const fallback = [
    "## Operational Task State",
    "",
    `**Live task state temporarily unavailable** (\`${url}\`: ${reason}). Retry the Tasks API in a moment.`,
    "Do **not** fall back to scanning files (`PROJECT.md`, `SESSIONS.md`, `tasks.json`, or the `~/.openclaw/projects` tree) for task state.",
    "",
  ].join("\n");
  return rulesApi?.buildOperationalTaskStateMarkdown?.(null, { transient: { url, reason } }) || fallback;
}

async function getTaskStatusSummary(projectName) {
  let data;
  const url = `http://localhost:${FLOWBOARD_PORT}/api/projects/${encodeURIComponent(projectName)}/tasks?includeArchived=false`;
  try {
    const res = await fetchWithRetry(url);
    if (!res.ok) return { ok: false, markdown: buildTaskStateUnavailableMarkdown(url, `HTTP ${res.status}`) };
    data = await res.json();
  } catch (err) {
    return { ok: false, markdown: buildTaskStateUnavailableMarkdown(url, err?.message || "fetch failed") };
  }
  if (!Array.isArray(data?.tasks)) {
    return {
      ok: false,
      markdown: rulesApi?.buildOperationalTaskStateMarkdown?.(null, {
        blocker: `\`${url}\` returned JSON without a \`tasks\` array.`,
      }) || `## Operational Task State\n\n**BLOCKER:** \`${url}\` returned JSON without a \`tasks\` array.\n`,
    };
  }
  return {
    ok: true,
    markdown: rulesApi?.buildOperationalTaskStateMarkdown?.(data.tasks) || "## Operational Task State\n\nLive task state is available from the Tasks API.\n",
  };
}

async function buildBootstrapContent(workspaceDir, agentId) {
  const identitySection = buildIdentitySection(agentId);

  // Resolve active project: DB canonical via API. Legacy file fallback is
  // opt-in only and never runs after an authoritative API null.
  const apiResult = await resolveActiveProjectFromApi(agentId);
  let projectName = null;
  // T-230: distinguish an authoritative null (API said no project) from a
  // transient API failure (status unknown). They must produce different
  // headers — see below.
  let statusUnknown = false;
  if (apiResult.ok) {
    projectName = apiResult.project;
  } else {
    console.warn(`[project-context] FlowBoard status unavailable for ${agentId}: ${apiResult.reason}; trying legacy file fallback if enabled`);
    projectName = resolveActiveProjectFromFile(workspaceDir);
    if (!projectName) statusUnknown = true;
  }

  if (!projectName) {
    // Emit a load-bearing header before Identity so the model reads it instead
    // of inferring a project from conversation context. On a transient API
    // failure use the soft "unknown" header (do not assert "no project"); only
    // an authoritative API null gets the hard "No Active Project" header.
    const header = statusUnknown
      ? buildProjectUnavailableSection(apiResult.reason)
      : buildNoActiveProjectSection();
    return header + "\n" + identitySection;
  }

  const rulesManifest = buildRulesManifest();
  const projectRoot = existsSync(SHARED_PROJECTS_DIR) ? SHARED_PROJECTS_DIR : join(workspaceDir, "projects");

  const projectMdPath = join(projectRoot, projectName, "PROJECT.md");
  let projectContent = "";
  if (existsSync(projectMdPath)) {
    try { projectContent = readFileSync(projectMdPath, "utf8"); } catch {}
  }

  const sections = [
    `# Active Project: ${projectName}\n`,
    `${identitySection}`,
    `${rulesManifest}\n`,
  ];

  const taskSummary = await getTaskStatusSummary(projectName);
  sections.push(`${taskSummary.markdown}\n`);

  if (projectContent) {
    sections.push([
      `## Project Knowledge: ${projectName}`,
      "",
      "The following `PROJECT.md` content is stable project knowledge only.",
      "It is not authoritative for current task focus, claims, review state, or next work; use the `Operational Task State` section above and the Tasks API for that.",
      "",
      projectContent,
      "",
    ].join("\n"));
  }

  return sections.join("\n");
}

const handler = async (event) => {
  // Only react to agent:bootstrap. Replaces the four legacy subscriptions
  // (command:new, command:reset, gateway:startup, session:compact:after) —
  // agent:bootstrap fires before every agent run, so it covers all session
  // boundaries including daily reset, idle expiry, and project-activate via
  // PUT /api/status (which is implicitly observed on the next run).
  if (event.type !== "agent" || event.action !== "bootstrap") return;

  const context = event.context;
  if (!context || !Array.isArray(context.bootstrapFiles)) return;

  const workspaceDir = context.workspaceDir;
  // T-168 review fix: workspace-derived agentId wins over event.context.agentId.
  // The workspace directory is the canonical filesystem-routed identity that
  // OpenClaw bound this run to; context.agentId is best-effort metadata that
  // can be stale, mis-routed, or absent. Trusting context.agentId first
  // produced wrong-content injection for valid OpenClaw runs whose context
  // agentId disagreed with the workspace path.
  const agentId = deriveAgentIdFromWorkspace(workspaceDir) || context.agentId || "main";

  let content;
  try {
    content = await buildBootstrapContent(workspaceDir, agentId);
  } catch (err) {
    console.warn(`[project-context] build failed for ${agentId}: ${err?.message ?? err}`);
    // Fail safe: do not strip the existing BOOTSTRAP.md; let whatever the
    // workspace loader found stand.
    return;
  }
  // T-181-4: success-path observability line is opt-in via env-gate so it
  // doesn't spam logs in production. Errors above (rules-api boot warning
  // line ~35, build-failure warning line ~262) stay ungated — failures
  // must remain visible regardless of telemetry preference.
  if (process.env.FLOWBOARD_HOOK_TELEMETRY === '1') {
    console.log(`[project-context] injected for ${agentId} (${content.length}B)`);
  }

  if (!content) return;

  const newEntry = {
    name: BOOTSTRAP_FILENAME,
    path: workspaceDir ? join(workspaceDir, BOOTSTRAP_FILENAME) : BOOTSTRAP_FILENAME,
    content,
    missing: false,
  };

  const idx = context.bootstrapFiles.findIndex(f => f && f.name === BOOTSTRAP_FILENAME);
  if (idx >= 0) {
    context.bootstrapFiles[idx] = newEntry;
  } else {
    context.bootstrapFiles.push(newEntry);
  }
};

export default handler;
