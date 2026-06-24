'use strict';

/**
 * T-417-16 — Append-only destructive-action audit log (ClawHub: Excessive
 * Agency / no traceability).
 *
 * Every destructive or privileged API action appends one JSON line to
 * <PROJECTS_DIR>/.audit/destructive.log so that "who did what, when" is
 * answerable after the fact. The `.audit` directory is a dot-dir: it sits
 * under PROJECTS_DIR (outside any single project dir), is skipped by the file
 * tree and drift detection, and is unreachable via the file read route (path
 * containment + the T-417-14 knowledge-layer allow-list).
 *
 * Under the local-first trust model this is attribution, not access control:
 * the actor is self-asserted (req.user.agentId or body.actor). It records what
 * happened; it does not authenticate who did it. That is correct for the
 * single-trusted-operator deployment and is documented honestly in SECURITY.md.
 *
 * The logger is FAIL-SOFT by contract: a logging failure must NEVER propagate
 * into the request it is auditing. It catches everything and returns a boolean.
 */

const fs = require('fs');
const path = require('path');

/**
 * Resolve the acting principal for an audit entry from an Express request.
 * Self-asserted under the local-first model; 'localhost-unauth' when nothing
 * is supplied (the default loopback-bypass case).
 */
function resolveActor(req) {
  if (req) {
    if (req.user && req.user.agentId) return req.user.agentId;
    if (req.body && req.body.actor) return req.body.actor;
  }
  return 'localhost-unauth';
}

/**
 * Append one audit entry. Never throws.
 * @param {{action:string, project?:string, target?:string, actor?:string}} entry
 * @param {{dir:string}} opts  directory to hold destructive.log (the .audit dir)
 * @returns {boolean} true if written, false if the write failed (logged + swallowed)
 */
function auditDestructive(entry, opts = {}) {
  try {
    const dir = opts.dir;
    if (!dir) throw new Error('audit dir not configured');
    fs.mkdirSync(dir, { recursive: true });
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      action: entry.action,
      project: entry.project ?? null,
      target: entry.target ?? null,
      actor: entry.actor || 'localhost-unauth',
    }) + '\n';
    fs.appendFileSync(path.join(dir, 'destructive.log'), line);
    return true;
  } catch (err) {
    console.warn('[audit-log] failed to record destructive action:', err.message);
    return false;
  }
}

module.exports = { auditDestructive, resolveActor };
