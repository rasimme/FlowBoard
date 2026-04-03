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

function resolveWorkspace(event) {
  // Prefer workspace directory from event context (supports multi-agent workspaces)
  if (event?.context?.workspaceDir) {
    const dir = event.context.workspaceDir;
    if (existsSync(join(dir, "ACTIVE-PROJECT.md"))) return dir;
  }

  // Fallback: scan common workspace locations
  const base = join(homedir(), ".openclaw");
  const candidates = [join(base, "workspace")];
  try {
    // Also check workspace-* directories (multi-agent setups)
    const entries = readdirSync(base, { withFileTypes: true });
    for (const e of entries) {
      if (e.isDirectory() && e.name.startsWith("workspace-")) {
        candidates.push(join(base, e.name));
      }
    }
  } catch {}
  for (const dir of candidates) {
    if (existsSync(join(dir, "ACTIVE-PROJECT.md"))) return dir;
  }
  return null;
}

/**
 * Trim SESSION LOG in PROJECT.md to only the last N session entries.
 * Keeps everything before "## Session Log" intact, then appends
 * only the last N "### ..." entries from the log.
 */
function trimSessionLog(content, maxSessions = 2) {
  const sessionLogMatch = content.match(/^(## Session Log)\s*$/m);
  if (!sessionLogMatch) return content; // no session log section

  const splitIndex = sessionLogMatch.index;
  const beforeLog = content.slice(0, splitIndex);
  const logSection = content.slice(splitIndex);

  // Split log into entries by ### headers
  const entryPattern = /^### .+$/gm;
  const entries = [];
  let match;
  const matches = [];
  while ((match = entryPattern.exec(logSection)) !== null) {
    matches.push(match.index);
  }

  if (matches.length === 0) return content; // no entries, keep as-is

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i];
    const end = i + 1 < matches.length ? matches[i + 1] : logSection.length;
    entries.push(logSection.slice(start, end).trimEnd());
  }

  // Keep only first N entries (newest are at the top, prepended by agent)
  const kept = entries.slice(0, maxSessions);
  const trimmedLog = `## Session Log\n\n${kept.join("\n\n")}\n`;

  return beforeLog + trimmedLog;
}

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
    return;
  }

  // Read PROJECT-RULES.md
  const rulesPath = join(workspaceDir, "projects", "PROJECT-RULES.md");
  let rulesContent = "";
  if (existsSync(rulesPath)) {
    try { rulesContent = readFileSync(rulesPath, "utf8"); } catch {}
  }

  // Read PROJECT.md (smart: trim session log to last N entries)
  const projectMdPath = join(workspaceDir, "projects", projectName, "PROJECT.md");
  let projectContent = "";
  if (existsSync(projectMdPath)) {
    try { projectContent = readFileSync(projectMdPath, "utf8"); } catch {}
  }

  // Smart Session Log trimming: keep only last 2 sessions in bootstrap
  if (projectContent) {
    projectContent = trimSessionLog(projectContent, 2);
  }

  if (!rulesContent && !projectContent) return;

  const sections = [`# Active Project: ${projectName}\n`];
  if (rulesContent) sections.push(`## Project Rules\n\n${rulesContent}\n`);
  if (projectContent) sections.push(`## Project: ${projectName}\n\n${projectContent}\n`);

  // Add task status summary (fetched from FlowBoard API / HZL backend)
  const taskSummary = await getTaskStatusSummary(projectName);
  if (taskSummary) {
    sections.push(`## Current Task Status\n\n${taskSummary}\n`);
  }

  try {
    writeFileSync(bootstrapPath, sections.join("\n"));
    console.log(`[project-context] Updated BOOTSTRAP.md for project: ${projectName}`);
  } catch (err) {
    console.error(`[project-context] Failed to write BOOTSTRAP.md:`, err.message);
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
