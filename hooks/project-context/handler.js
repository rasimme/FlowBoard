/**
 * Project Context Hook
 * 
 * On /new and /reset: writes active project context to BOOTSTRAP.md
 * so it's automatically loaded as a bootstrap file in the next session.
 * 
 * On gateway:startup: same — ensures BOOTSTRAP.md has current project context.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
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
 * Returns project name string or null. Fails soft if server is unreachable.
 */
async function resolveActiveProjectFromApi(agentId) {
  try {
    const url = `http://localhost:${FLOWBOARD_PORT}/api/status?agentId=${encodeURIComponent(agentId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    return data.activeProject || null;
  } catch {
    return null;
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

async function updateBootstrapWithProjectContext(workspaceDir, agentId) {
  if (!workspaceDir) return;

  // T-131-3: resolve active project from DB (via API) first; file is migration fallback
  let projectName = await resolveActiveProjectFromApi(agentId || 'main');

  if (projectName !== null) {
    console.log(`[project-context] Active project from DB (agent: ${agentId}): ${projectName || 'none'}`);
  } else {
    // File-based fallback: used during migration or when server is not yet running
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

  if (!projectName) {
    // No active project — clear BOOTSTRAP.md
    try { writeFileSync(bootstrapPath, ""); } catch {}
    return { ok: true, projectName: null, bootstrapUpdated: true };
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

  const sections = [`# Active Project: ${projectName}\n`, `${rulesManifest}\n`];
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
