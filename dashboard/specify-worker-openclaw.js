'use strict';

/**
 * OpenClaw CLI worker adapter — runs one synchronous Specify worker step per
 * call via `openclaw agent --json`.
 *
 * The worker is stateless: every call carries the full session context and
 * must answer with exactly one JSON object (see specify-policy.js for the
 * response contract). No dedicated agent is required: the default targets the
 * `main` agent, which exists on every OpenClaw installation, inside an
 * isolated per-session session key. Spec: T-262-9 (Specify Clarify Loop).
 *
 * Env:
 *   SPECIFY_WORKER_AGENT    agent id to run worker turns on (default: main)
 *   SPECIFY_WORKER_TIMEOUT  per-step timeout in seconds (default: 90)
 *   SPECIFY_OPENCLAW_CLI    openclaw binary (default: openclaw on PATH)
 */

const { execFile } = require('child_process');
const policy = require('./specify-policy');

const RESPONSE_SCHEMA_HINT = `Respond with EXACTLY ONE JSON object and nothing else — no markdown, no code fences, no commentary. Schema:
{
  "action": "question" | "proposal" | "error",
  "ambiguityScan": { "identifiedGaps": ["scope"|"users"|"data"|"behavior"|"constraints", ...], "confidence": 0.0-1.0 },
  // when action = "question":
  "question": {
    "text": "<one clarification question, English>",
    "options": [ { "key": "A", "label": "<short label>", "rationale": "<why>" }, ... 2-4 options, or [] for free-text ],
    "recommended": "<key of the recommended option>",
    "affectedFields": ["<which FR / user story / success criterion the answer changes>"]
  },
  // when action = "proposal":
  "proposal": {
    "summary": "<1-2 sentence summary of what will be built>",
    "taskStructure": "Single task" | "Parent + subtasks" | "Parent + subtasks with individual specs",
    "specContent": "<full spec markdown: Goal, User Stories, Functional Requirements (testable), Success Criteria (measurable), Clarifications (if any were asked)>",
    "taskBreakdown": [ { "title": "<task title, max 128 chars>", "description": "<short description>", "priority": "low"|"medium"|"high" }, ... ],
    "sourceCleanupPlan": ["<source note ids to delete after persistence>"]
  },
  // when action = "error":
  "message": "<why you cannot proceed>"
}`;

const POLICY_RULES = `Rules:
- First, internally scan the input across 5 categories: Scope, Users, Data, Behavior, Constraints. Report gaps in ambiguityScan.
- Ask AT MOST ${policy.MAX_CLARIFICATIONS} clarification questions per session, ONE per response. Prefer 2-4 concrete options with one recommended; free-text only when options make no sense.
- Only ask when the answer materially changes a requirement, user story, success criterion, task decomposition, test design, or operational risk. Name that in affectedFields.
- Never ask about implementation details. Never ask when a reasonable low-risk default exists — use the default instead.
- Questions, options, and the spec are written in English.
- When you produce the proposal: justify the task structure (single task vs parent+subtasks) in the summary, make functional requirements testable and success criteria measurable, and include a Clarifications section recording every question and answer.
- Directive semantics: "next" = normal step; "skip-remaining" = the user skipped remaining questions, produce the proposal now using recommended options/defaults; "force-proposal" = question budget exhausted, produce the proposal now; "require-clarification" = the input is a single underspecified note, ask at least one clarifying question before proposing.`;

function _defaults() {
  return {
    agentId: process.env.SPECIFY_WORKER_AGENT || 'main',
    timeoutSec: parseInt(process.env.SPECIFY_WORKER_TIMEOUT, 10) || 90,
    cli: process.env.SPECIFY_OPENCLAW_CLI || 'openclaw',
  };
}

/**
 * Build the one-shot worker prompt from a bridge worker request.
 */
function buildWorkerPrompt(workerRequest) {
  const ctx = {
    project: workerRequest.project,
    origin: workerRequest.origin,
    directive: workerRequest.directive || policy.DIRECTIVES.NEXT,
    input: workerRequest.input || {},
  };
  return [
    'You are the FlowBoard Specify worker: a requirements analyst that turns unstructured ideas into a high-quality spec and task breakdown through targeted clarification questions.',
    '',
    POLICY_RULES,
    '',
    `Session context (JSON):`,
    JSON.stringify(ctx, null, 2),
    '',
    RESPONSE_SCHEMA_HINT,
  ].join('\n');
}

/**
 * Extract the first JSON object from raw model output.
 * Tolerates code fences and surrounding prose. Returns null on failure.
 */
function extractJsonObject(text) {
  if (typeof text !== 'string' || !text.trim()) return null;
  const cleaned = text.replace(/```(?:json)?/g, '');
  const start = cleaned.indexOf('{');
  if (start === -1) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (escaped) { escaped = false; continue; }
    if (ch === '\\') { escaped = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === '{') depth++;
    if (ch === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(cleaned.slice(start, i + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

// FlowBoard sets gateway URL/port env vars for its own webhook calls. They
// must not leak into the CLI invocation: the CLI treats them as a gateway
// override and then demands explicit credentials instead of using its own
// config resolution.
const STRIPPED_ENV_VARS = ['OPENCLAW_GATEWAY_URL', 'GATEWAY_URL', 'OPENCLAW_GATEWAY_PORT', 'GATEWAY_PORT'];

function _cliEnv() {
  const env = { ...process.env };
  for (const key of STRIPPED_ENV_VARS) delete env[key];
  return env;
}

function _execCli(cli, args, timeoutMs) {
  return new Promise((resolve) => {
    execFile(cli, args, { timeout: timeoutMs, maxBuffer: 16 * 1024 * 1024, env: _cliEnv() }, (err, stdout, stderr) => {
      resolve({ err, stdout: stdout || '', stderr: stderr || '' });
    });
  });
}

/**
 * Create the OpenClaw CLI worker adapter.
 * opts: { agentId?, timeoutSec?, cli?, exec? } — exec is injectable for tests.
 */
function createOpenClawCliAdapter(opts = {}) {
  const cfg = { ..._defaults(), ...opts };
  const exec = opts.exec || _execCli;

  return {
    kind: 'openclaw-cli',
    agentId: cfg.agentId,

    async call(sessionId, workerRequest) {
      const prompt = buildWorkerPrompt(workerRequest);
      const sessionKey = `agent:${cfg.agentId}:flowboard-specify-${sessionId}`;
      const args = [
        'agent',
        '--agent', cfg.agentId,
        '--session-key', sessionKey,
        '--message', prompt,
        '--json',
        '--timeout', String(cfg.timeoutSec),
      ];

      // Allow a little slack over the CLI's own timeout before killing the process.
      const { err, stdout, stderr } = await exec(cfg.cli, args, (cfg.timeoutSec + 15) * 1000);

      if (err) {
        let reason = err.killed ? `timed out after ${cfg.timeoutSec}s` : (err.message || 'CLI failed');
        if (err.code === 'ENOENT') {
          reason = `openclaw CLI not found at "${cfg.cli}" — set SPECIFY_OPENCLAW_CLI to the binary path`;
        }
        return { action: 'error', message: `Specify worker call failed: ${reason}` };
      }

      let envelope;
      try {
        envelope = JSON.parse(stdout);
      } catch {
        return { action: 'error', message: 'Specify worker returned unparseable CLI output' };
      }

      if (!envelope || envelope.status !== 'ok') {
        const detail = envelope && (envelope.summary || envelope.error || envelope.status);
        return { action: 'error', message: `Specify worker run failed: ${detail || 'unknown gateway error'}${stderr ? '' : ''}` };
      }

      const text = (envelope.result && Array.isArray(envelope.result.payloads))
        ? envelope.result.payloads.map(p => p && p.text).filter(Boolean).join('\n')
        : '';

      const response = extractJsonObject(text);
      if (!response) {
        return { action: 'error', message: 'Specify worker reply contained no parseable JSON object' };
      }
      return response;
    },
  };
}

module.exports = {
  createOpenClawCliAdapter,
  buildWorkerPrompt,
  extractJsonObject,
};
