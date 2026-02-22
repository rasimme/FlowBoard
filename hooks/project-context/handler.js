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

  // Read PROJECT.md
  const projectMdPath = join(workspaceDir, "projects", projectName, "PROJECT.md");
  let projectContent = "";
  if (existsSync(projectMdPath)) {
    try { projectContent = readFileSync(projectMdPath, "utf8"); } catch {}
  }

  if (!rulesContent && !projectContent) return;

  const sections = [`# Active Project: ${projectName}\n`];
  if (rulesContent) sections.push(`## Project Rules\n\n${rulesContent}\n`);
  if (projectContent) sections.push(`## Project: ${projectName}\n\n${projectContent}\n`);

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
