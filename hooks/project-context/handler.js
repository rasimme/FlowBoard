/**
 * Project Context Hook — agent:bootstrap live-inject
 *
 * On every agent run, OpenClaw fires `agent:bootstrap` to assemble the
 * bootstrap-files array that gets injected into the model context. This
 * hook reads the canonical active-project state from the FlowBoard DB
 * (via the local API) and replaces the BOOTSTRAP.md entry in
 * `event.context.bootstrapFiles` with a live-built document containing
 * the active-project header, the agent's identity, the rules manifest,
 * the PROJECT.md content, and a task-status summary.
 *
 * No on-disk writes. Single source of truth: flowboard_agents DB row.
 * Documented in specs/T-168-hook-lifecycle-coverage.md (T-168-3).
 */

import { readFileSync, existsSync } from "node:fs";
import { basename, join } from "node:path";
import { homedir } from "node:os";
import { createRequire } from "node:module";

const OPENCLAW_HOME = join(homedir(), ".openclaw");
const SHARED_PROJECTS_DIR = process.env.FLOWBOARD_PROJECTS_DIR || join(OPENCLAW_HOME, "projects");
const FLOWBOARD_REPO = process.env.FLOWBOARD_REPO || join(homedir(), "repos", "FlowBoard");
const FLOWBOARD_PORT = process.env.FLOWBOARD_PORT || 18790;
const BOOTSTRAP_FILENAME = "BOOTSTRAP.md";

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

// Discriminated result so callers can distinguish authoritative null
// (no project active) from a network failure.
async function resolveActiveProjectFromApi(agentId) {
  try {
    const url = `http://localhost:${FLOWBOARD_PORT}/api/status?agentId=${encodeURIComponent(agentId)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
    const data = await res.json();
    return { ok: true, project: data.activeProject || null };
  } catch (err) {
    return { ok: false, reason: err?.message || "fetch failed" };
  }
}

// Pre-bootstrap fallback: if the API is unreachable (gateway boot before
// FlowBoard server is up, migration setups), read the legacy
// ACTIVE-PROJECT.md file. An authoritative `null` from the API does NOT
// trigger this path.
function resolveActiveProjectFromFile(workspaceDir) {
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

async function getTaskStatusSummary(projectName) {
  let data;
  try {
    const url = `http://localhost:${FLOWBOARD_PORT}/api/projects/${encodeURIComponent(projectName)}/tasks?includeArchived=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    data = await res.json();
  } catch {
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

async function buildBootstrapContent(workspaceDir, agentId) {
  const identitySection = buildIdentitySection(agentId);

  // Resolve active project: DB canonical via API, file fallback only on network failure
  const apiResult = await resolveActiveProjectFromApi(agentId);
  let projectName = null;
  if (apiResult.ok) {
    projectName = apiResult.project;
  } else {
    projectName = resolveActiveProjectFromFile(workspaceDir);
  }

  if (!projectName) {
    // No active project — emit the explicit "no project" header before
    // Identity so the model has a load-bearing marker to read instead of
    // inferring an active project from conversation context.
    return buildNoActiveProjectSection() + "\n" + identitySection;
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
  if (projectContent) sections.push(`## Project: ${projectName}\n\n${projectContent}\n`);

  const taskSummary = await getTaskStatusSummary(projectName);
  if (taskSummary) sections.push(`## Current Task Status\n\n${taskSummary}\n`);

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
  const agentId = context.agentId || deriveAgentIdFromWorkspace(workspaceDir) || "main";

  let content;
  try {
    content = await buildBootstrapContent(workspaceDir, agentId);
  } catch (err) {
    console.warn(`[project-context] build failed for ${agentId}: ${err?.message ?? err}`);
    // Fail safe: do not strip the existing BOOTSTRAP.md; let whatever the
    // workspace loader found stand.
    return;
  }
  // Single observability line. Useful while the live-inject migration is
  // fresh; reduce to debug or remove once T-168 is fully shipped.
  console.log(`[project-context] injected for ${agentId} (${content.length}B)`);

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
