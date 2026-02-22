var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

// handler.ts
var handler_exports = {};
__export(handler_exports, {
  default: () => handler_default
});
module.exports = __toCommonJS(handler_exports);
var fs = __toESM(require("fs"));
var path = __toESM(require("path"));
var readline = __toESM(require("readline"));
var SESSION_STATE_FILE = "SESSION-STATE.md";
var MAX_MESSAGES = 50;
var MAX_CHARS_PER_MESSAGE = 500;
function fileExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}
function readFileSafe(filePath) {
  try {
    return fs.readFileSync(filePath, "utf-8");
  } catch {
    return null;
  }
}
function extractTextContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter((block) => block.type === "text" && block.text).map((block) => block.text).join("\n");
  }
  return "";
}
async function readLastMessages(sessionFile, maxMessages) {
  if (!fileExists(sessionFile)) return [];
  const messages = [];
  try {
    const fileStream = fs.createReadStream(sessionFile);
    const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.role === "user" || entry.role === "assistant") {
          const text = extractTextContent(entry.content);
          if (text.trim()) {
            messages.push({
              role: entry.role,
              content: text.substring(0, MAX_CHARS_PER_MESSAGE)
            });
          }
        }
      } catch {
      }
    }
  } catch (err) {
    console.error("[simme-memory] Error reading transcript:", err);
    return [];
  }
  return messages.slice(-maxMessages);
}
function formatConversationForPrompt(messages) {
  return messages.map((msg) => {
    const role = msg.role === "user" ? "User" : "Assistant";
    return `${role}: ${msg.content}`;
  }).join("\n\n");
}
async function summarizeWithLLM(conversation, config) {
  const gatewayPort = config?.gateway?.port ?? 18789;
  const gatewayToken = config?.gateway?.auth?.token;
  if (!gatewayToken) {
    console.warn("[simme-memory] No gateway token available");
    return null;
  }
  const systemPrompt = `You are summarizing a conversation session. Create a concise SESSION-STATE.md that captures:

1. **Current Task** - What was being worked on
2. **Key Context** - Important facts, decisions, or discoveries  
3. **Pending Actions** - What still needs to be done
4. **Blockers** - Any issues or problems encountered

Keep it brief and actionable. Use bullet points. Focus on what the next session needs to know to continue effectively.

Format your response as markdown, starting with "## Current Task".`;
  const userPrompt = `Summarize this conversation into a SESSION-STATE.md:

${conversation}`;
  try {
    const response = await fetch(`http://localhost:${gatewayPort}/v1/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${gatewayToken}`
      },
      body: JSON.stringify({
        model: "anthropic/claude-haiku-4-5",
        // Fast and cheap
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: userPrompt }
        ],
        max_tokens: 800
      })
    });
    if (!response.ok) {
      const errorText = await response.text();
      console.error("[simme-memory] LLM request failed:", response.status, errorText);
      return null;
    }
    const result = await response.json();
    const content = result.choices?.[0]?.message?.content;
    if (content) {
      console.log("[simme-memory] LLM summary generated");
      return content;
    }
  } catch (err) {
    console.error("[simme-memory] LLM request error:", err);
  }
  return null;
}
function createFallbackContent(messages) {
  const formatted = messages.slice(-10).map((msg) => {
    const role = msg.role === "user" ? "\u{1F464} User" : "\u{1F916} Assistant";
    return `### ${role}
${msg.content}`;
  }).join("\n\n");
  return `## Recent Conversation (Fallback)

*LLM summarization failed. Showing last 10 messages.*

${formatted}`;
}
function resolveWorkspaceDir(event) {
  if (event.context.workspaceDir) {
    return event.context.workspaceDir;
  }
  const cfg = event.context.cfg;
  if (cfg?.agents?.defaults?.workspace) {
    return cfg.agents.defaults.workspace;
  }
  if (cfg?.workspace?.dir) {
    return cfg.workspace.dir;
  }
  return null;
}
async function handleSessionEnd(event) {
  const workspace = resolveWorkspaceDir(event);
  const config = event.context.cfg;
  if (!workspace) {
    console.warn("[simme-memory] No workspace directory (not in context or cfg)");
    return;
  }
  const sessionEntry = event.context.previousSessionEntry || event.context.sessionEntry;
  const sessionFile = sessionEntry?.transcriptPath || event.context.sessionFile;
  console.log("[simme-memory] Processing session end...");
  const sessionStatePath = path.join(workspace, SESSION_STATE_FILE);
  let messages = [];
  if (sessionFile && fileExists(sessionFile)) {
    messages = await readLastMessages(sessionFile, MAX_MESSAGES);
    console.log(`[simme-memory] Read ${messages.length} messages`);
  }
  if (messages.length === 0) {
    console.log("[simme-memory] No messages to save");
    return;
  }
  const conversation = formatConversationForPrompt(messages);
  let summaryContent = await summarizeWithLLM(conversation, config);
  if (!summaryContent) {
    console.log("[simme-memory] Using fallback (no LLM)");
    summaryContent = createFallbackContent(messages);
  }
  const timestamp = (/* @__PURE__ */ new Date()).toISOString();
  const content = `# SESSION-STATE.md

> Previous session context. Continue where you left off.

*Last updated: ${timestamp}*
*Session: ${event.sessionKey}*

---

${summaryContent}

---

*Auto-generated by simme-memory hook*
`;
  try {
    fs.writeFileSync(sessionStatePath, content, "utf-8");
    console.log(`[simme-memory] Saved: ${sessionStatePath}`);
    event.messages.push(`\u{1F9E0} Session summarized and saved`);
  } catch (err) {
    console.error("[simme-memory] Failed to save:", err);
  }
}
async function handleSessionStart(event) {
  const workspace = event.context.workspaceDir;
  if (!workspace) return;
  const sessionStatePath = path.join(workspace, SESSION_STATE_FILE);
  if (!fileExists(sessionStatePath)) return;
  const content = readFileSafe(sessionStatePath);
  if (!content?.trim()) return;
  if (Array.isArray(event.context.bootstrapFiles)) {
    event.context.bootstrapFiles.push({
      path: SESSION_STATE_FILE,
      content,
      virtual: true
    });
    console.log("[simme-memory] Injected SESSION-STATE.md");
  }
}
var handler = async (event) => {
  if (event.type === "command" && event.action === "new") {
    await handleSessionEnd(event);
    return;
  }
  if (event.type === "agent" && event.action === "bootstrap") {
    await handleSessionStart(event);
    return;
  }
};
var handler_default = handler;
