/**
 * Project Context Hook
 * 
 * On /new and /reset: writes active project context to BOOTSTRAP.md
 * so it's automatically loaded as a bootstrap file in the next session.
 * 
 * On gateway:startup: same — ensures BOOTSTRAP.md has current project context.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";

function resolveWorkspace() {
  // Try common workspace locations
  const candidates = [
    join(homedir(), ".openclaw", "workspace"),
  ];
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
 * Read tasks.json for a project and return a status summary string.
 * Returns null if no actionable info.
 */
function getTaskStatusSummary(workspaceDir, projectName) {
  const tasksPath = join(workspaceDir, "projects", projectName, "tasks.json");
  if (!existsSync(tasksPath)) return null;

  let data;
  try { data = JSON.parse(readFileSync(tasksPath, "utf8")); } catch { return null; }
  if (!data?.tasks?.length) return null;

  const inProgress = data.tasks.filter(t => t.status === "in-progress");
  const review = data.tasks.filter(t => t.status === "review");
  const open = data.tasks.filter(t => t.status === "open");

  const lines = [];
  if (inProgress.length) {
    lines.push("**⚡ In Progress:**");
    for (const t of inProgress) {
      lines.push(`- ${t.id}: ${t.title}${t.specFile ? ` (spec: ${t.specFile})` : ""}`);
    }
  }
  if (review.length) {
    lines.push("**🔍 Waiting for Review:**");
    for (const t of review) {
      lines.push(`- ${t.id}: ${t.title}`);
    }
  }
  if (!inProgress.length && !review.length) {
    lines.push(`**💡 No task in-progress.** ${open.length} open task(s) available — pick one and set it to in-progress before starting work.`);
  }

  lines.push("");
  lines.push("**Reminder:** Always set a task to `in-progress` before starting work. Set to `review` when done. Never leave tasks in stale states.");

  return lines.join("\n");
}

function updateBootstrapWithProjectContext(workspaceDir) {
  if (!workspaceDir) return;

  const activeProjectPath = join(workspaceDir, "ACTIVE-PROJECT.md");
  if (!existsSync(activeProjectPath)) return;

  let content;
  try { content = readFileSync(activeProjectPath, "utf8"); } catch { return; }

  const match = content.match(/^project:\s*(.+)$/m);
  const projectName = match?.[1]?.trim();
  
  const bootstrapPath = join(workspaceDir, "BOOTSTRAP.md");

  if (!projectName || projectName === "none") {
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

  // Add task status summary
  const taskSummary = getTaskStatusSummary(workspaceDir, projectName);
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
  // Trigger on /new, /reset, and gateway startup
  if (event.type === "command" && (event.action === "new" || event.action === "reset")) {
    const workspaceDir = event.context?.workspaceDir || resolveWorkspace();
    updateBootstrapWithProjectContext(workspaceDir);
  }
  
  if (event.type === "gateway" && event.action === "startup") {
    updateBootstrapWithProjectContext(resolveWorkspace());
  }
};

export default handler;
