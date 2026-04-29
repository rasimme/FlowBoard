/**
 * Project Context Hook
 * 
 * On /new and /reset: writes active project context to BOOTSTRAP.md
 * so it's automatically loaded as a bootstrap file in the next session.
 * 
 * On gateway:startup: same — ensures BOOTSTRAP.md has current project context.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || join(OPENCLAW_HOME, "projects");
const FLOWBOARD_REPO = process.env.FLOWBOARD_REPO || join(homedir(), "repos", "FlowBoard");

// Single-source-of-truth: load rules-api.js from the FlowBoard repo so the bootstrap
// manifest matches the server's. Fall back to an inline minimal manifest if the repo
// module can't be resolved (e.g. hook runs before the repo is present).
const require = createRequire(import.meta.url);
let rulesApi = null;
try {
  rulesApi = require(join(FLOWBOARD_REPO, "dashboard", "rules-api.js"));
} catch (err) {
  console.warn(`[project-context] rules-api module unavailable (${err.message}); using inline manifest fallback`);
}

// T-161 Identity-in-Bootstrap: derive the agent's canonical id from the
// workspace directory name. The mapping is fixed by the workspace-naming
// convention used across the OpenClaw installation:
//   ~/.openclaw/workspace             → agent "main"
//   ~/.openclaw/workspace-<id>        → agent "<id>"
// Returning null means "couldn't derive" — caller falls back to the
// event/env-supplied id (which may itself be wrong; see resolveAgentId).
function deriveAgentIdFromWorkspace(workspaceDir) {
  if (!workspaceDir) return null;
  const base = basename(workspaceDir);
  if (base === "workspace") return "main";
  if (base.startsWith("workspace-")) return base.slice("workspace-".length);
  return null;
}

// T-161 Identity-in-Bootstrap: a stable, self-describing block that tells
// the agent its own id at session start. Single source of truth, derived
// once by the hook here so the agent never has to introspect env vars or
// parse cwd in a curl one-liner. This block is the workspace-level
// identity (project-independent) and is always emitted, even when no
// project is active, so /api/status PUTs work too.
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

function resolveWorkspace(event) {
  // Prefer workspace directory from event context (supports multi-agent workspaces)
  if (event?.context?.workspaceDir) {
    return event.context.workspaceDir;
  }

  const agentId = event?.context?.agentId || process.env.OPENCLAW_AGENT_ID;
  const base = OPENCLAW_HOME;

  // Agent-specific workspace convention: workspace-<agentId>
  if (agentId) {
    const byAgent = join(base, `workspace-${agentId}`);
    if (existsSync(byAgent)) return byAgent;
  }

  // Fallback: main workspace, then any workspace-* directory
  const candidates = [join(base, "workspace")];
  try {
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("workspace-")) {
        candidates.push(join(base, e.name));
      }
    }
  } catch {}
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  return null;
}

/**
 * NOTE: trimSessionLog removed by T-131-4/m005 — session logs now live in SESSIONS.md
 */

/**
 * Fetch tasks from FlowBoard API (HZL-backed) and return a status summary string.
 * Falls back gracefully if the server is unreachable (e.g. during gateway startup).
 * Returns null if no actionable info.
 */
const FLOWBOARD_PORT = process.env.FLOWBOARD_PORT || 18790;

function resolveAgentId(event) {
  return event?.context?.agentId || process.env.OPENCLAW_AGENT_ID || 'main';
}

/**
 * T-131-3: Query FlowBoard API for the active project of the given agent.
 *
 * Returns a discriminated result so the caller can distinguish:
 *   { ok: true, project: string|null }  — API answered authoritatively;
 *                                         null means "no project active"
 *   { ok: false, reason: string }       — API unreachable / non-2xx; only
 *                                         in this case may the caller fall
 *                                         back to a file-based source
 *
 * Without this distinction, an authoritative `activeProject: null` from
 * the DB used to be indistinguishable from a network failure, which made
 * the legacy ACTIVE-PROJECT.md fallback win even when the DB had been
 * updated to "no project active" — producing stale BOOTSTRAP.md content.
 */
async function resolveActiveProjectFromApi(agentId) {
  try {
    const url = `http://localhost:${FLOWBOARD_PORT}/api/status?agentId=${encodeURIComponent(agentId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, project: data.activeProject || null };
  } catch (err) {
    return { ok: false, reason: err?.message || 'fetch failed' };
  }
}

async function getTaskStatusSummary(projectName) {
  let data;
  try {
    const res = await fetch(`http://localhost:${FLOWBOARD_PORT}/api/projects/${encodeURIComponent(projectName)}/tasks?includeArchived=false`, {
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
    console.log("[project-context] FlowBoard API unreachable — skipping task summary");
    return null;
  }
  if (!data?.tasks?.length) return null;

  const topLevel = data.tasks.filter(t => !t.parentId);
  const backlog = topLevel.filter(t => t.status === "backlog");
  const open = topLevel.filter(t => t.status === "open");
  const inProgress = topLevel.filter(t => t.status === "in-progress");
  const review = topLevel.filter(t => t.status === "review");
  const done = topLevel.filter(t => t.status === "done");
  const blocked = topLevel.filter(t => t.blocked === true);

  // Status counts summary line
  const countParts = [];
  if (backlog.length) countParts.push(`Backlog: ${backlog.length}`);
  if (open.length) countParts.push(`Open: ${open.length}`);
  if (inProgress.length) {
    const bCount = inProgress.filter(t => t.blocked).length;
    countParts.push(`In Progress: ${inProgress.length}${bCount ? ` (${bCount} blocked)` : ""}`);
  }
  if (review.length) {
    const bCount = review.filter(t => t.blocked).length;
    countParts.push(`Review: ${review.length}${bCount ? ` (${bCount} blocked)` : ""}`);
  }
  if (done.length) countParts.push(`Done: ${done.length}`);

  const lines = [];
  if (countParts.length) lines.push(`**Task counts:** ${countParts.join(" | ")}`);
  lines.push("");

  if (inProgress.length) {
    lines.push("**⚡ In Progress:**");
    for (const t of inProgress) {
      const blockedTag = t.blocked ? " 🚫 BLOCKED" : "";
      lines.push(`- ${t.id}: ${t.title}${blockedTag}${t.specFile ? ` (spec: ${t.specFile})` : ""}`);
    }
  }
  if (review.length) {
    lines.push("**🔍 Waiting for Review:**");
    for (const t of review) {
      const blockedTag = t.blocked ? " 🚫 BLOCKED" : "";
      lines.push(`- ${t.id}: ${t.title}${blockedTag}`);
    }
  }
  if (blocked.length && !inProgress.length && !review.length) {
    lines.push(`**🚫 Blocked tasks:** ${blocked.map(t => `${t.id} (${t.status})`).join(", ")}`);
  }
  if (!inProgress.length && !review.length) {
    lines.push(`**💡 No task in-progress.** ${open.length} open task(s) available — pick one and set it to in-progress before starting work.`);
  }

  lines.push("");
  lines.push("**Reminder:** Always set a task to `in-progress` before starting work. Set to `review` when done. Never leave tasks in stale states.");

  return lines.join("\n");
}

async function updateBootstrapWithProjectContext(workspaceDir, agentIdHint) {
  if (!workspaceDir) return;

  // T-161 Identity-in-Bootstrap: derive the canonical agent id from the
  // workspace directory. This wins over the event/env-supplied hint
  // because the workspace mapping is the actual source of truth on disk;
  // the hint can be stale or empty in some hook contexts.
  const agentId = deriveAgentIdFromWorkspace(workspaceDir) || agentIdHint || 'main';

  // T-131-3: resolve active project from DB (via API) — the DB is canonical.
  // Fall back to ACTIVE-PROJECT.md ONLY when the API itself is unreachable
  // (migration setups, gateway boot before FlowBoard server is up). An
  // authoritative `project: null` from the API means "no project active"
  // and must NOT trigger the file fallback — otherwise the (stale) legacy
  // file wins and BOOTSTRAP.md ends up with a project that was deactivated
  // hours or days ago.
  const apiResult = await resolveActiveProjectFromApi(agentId);
  let projectName = null;

  if (apiResult.ok) {
    projectName = apiResult.project;
    console.log(`[project-context] Active project from DB (agent: ${agentId}): ${projectName || 'none'}`);
  } else {
    console.warn(`[project-context] FlowBoard API unreachable (${apiResult.reason}) — reading ACTIVE-PROJECT.md as fallback`);
    const activeProjectPath = join(workspaceDir, "ACTIVE-PROJECT.md");
    if (existsSync(activeProjectPath)) {
      try {
        const content = readFileSync(activeProjectPath, "utf8");
        const match = content.match(/^project:\s*(.+)$/m);
        const name = match?.[1]?.trim();
        projectName = (name && name !== "none") ? name : null;
        if (projectName) console.log(`[project-context] Active project from file (fallback): ${projectName}`);
      } catch { /* no file — treat as no active project */ }
    }
  }

  const bootstrapPath = join(workspaceDir, "BOOTSTRAP.md");
  const identitySection = buildIdentitySection(agentId);

  if (!projectName) {
    // No active project — write only the Identity section so the agent
    // can still act on /api/status PUTs (project activation) with the
    // correct agentId. Previous behaviour cleared the file entirely,
    // which left no identity hint until a project was activated.
    try { writeFileSync(bootstrapPath, identitySection); } catch {}
    return { ok: true, projectName: null, bootstrapUpdated: true, agentId };
  }

  // Lazy-load: BOOTSTRAP.md carries only the rules manifest. Detailed sections are
  // fetched on demand via GET /api/projects/:name/rules/:section.
  const rulesManifest = buildRulesManifest();
  const projectRoot = existsSync(SHARED_PROJECTS_DIR) ? SHARED_PROJECTS_DIR : join(workspaceDir, "projects");

  // Read PROJECT.md (post-m005: session log lives in SESSIONS.md, not bootstrapped)
  const projectMdPath = join(projectRoot, projectName, "PROJECT.md");
  let projectContent = "";
  if (existsSync(projectMdPath)) {
    try { projectContent = readFileSync(projectMdPath, "utf8"); } catch {}
  }

  // Identity goes between the active-project header and the rules manifest
  // so the agent reads it before any other project context.
  const sections = [
    `# Active Project: ${projectName}\n`,
    `${identitySection}`,
    `${rulesManifest}\n`,
  ];
  if (projectContent) sections.push(`## Project: ${projectName}\n\n${projectContent}\n`);

  // Add task status summary (fetched from FlowBoard API / HZL backend)
  const taskSummary = await getTaskStatusSummary(projectName);
  if (taskSummary) {
    sections.push(`## Current Task Status\n\n${taskSummary}\n`);
  }

  try {
    writeFileSync(bootstrapPath, sections.join("\n"));
    console.log(`[project-context] Updated BOOTSTRAP.md for project: ${projectName}`);
    return { ok: true, projectName, bootstrapUpdated: true };
  } catch (err) {
    console.error(`[project-context] Failed to write BOOTSTRAP.md:`, err.message);
    return { ok: false, projectName, bootstrapUpdated: false, error: err.message };
  }
}

const handler = async (event) => {
  const agentId = resolveAgentId(event);

  // Trigger on /new, /reset, gateway startup, and after compaction
  if (event.type === "command" && (event.action === "new" || event.action === "reset")) {
    const workspaceDir = resolveWorkspace(event);
    await updateBootstrapWithProjectContext(workspaceDir, agentId);
  }

  if (event.type === "gateway" && event.action === "startup") {
    await updateBootstrapWithProjectContext(resolveWorkspace(event), agentId);
  }

  // T-121: Regenerate project context after compaction so rules survive LCM
  if (event.type === "session" && event.action === "compact:after") {
    const workspaceDir = resolveWorkspace(event);
    if (workspaceDir) {
      console.log("[project-context] Regenerating BOOTSTRAP.md after compaction");
      await updateBootstrapWithProjectContext(workspaceDir, agentId);
    }
  }
};

export default handler;
