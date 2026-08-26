'use strict';

/**
 * T-460 — test runs must never write an unversioned projects/ directory into
 * the repo root.
 *
 * Root cause: hzl-service.js resolves its own WORKSPACE/PROJECTS_DIR (used
 * for project scaffolding, specs/_index.json, etc.) from OPENCLAW_WORKSPACE
 * at require-time, falling back to path.resolve(__dirname, '..') — the repo
 * root — when it's unset. policy-ledger.js's defaultAuditDir() has the same
 * fallback shape for the policy-ledger audit dir. Any test that calls into
 * hzl-service.js's task/project-creation paths without first setting
 * OPENCLAW_WORKSPACE (or an equivalent override) leaks real files into the
 * shared, git-tracked repo tree — dangerous in a multi-agent shared worktree
 * where a later `git add -A` could sweep up another agent's in-flight test
 * artifacts.
 *
 * This pins two things:
 *  1. (static) every dashboard/test-*.{js,mjs} file that requires
 *     ./hzl-service.js directly (in-process, not via a spawned server.js
 *     subprocess) and performs at least one task/project-creation call also
 *     sets OPENCLAW_WORKSPACE/FLOWBOARD_POLICY_LEDGER_DIR/
 *     FLOWBOARD_PROJECTS_DIR before that require — a guard against a future
 *     test reintroducing the leak. This is exactly the audit that found the
 *     12 test files fixed by this task (test-compliance-detection.js,
 *     test-compliance-endpoints.js, test-handoff-package.js,
 *     test-handoff-smoke-integration.js, test-hzl-integration.js,
 *     test-hzl-race-recovery.js, test-lease-ownership.js,
 *     test-review-admin-transitions.js, test-spawn-wrapper.js,
 *     test-t447-2-policy-boundary.js, test-work-state-backend.js,
 *     test-workflows.js).
 *  2. (dynamic) actually running one of those previously-leaking tests does
 *     not create <repo>/projects/ — a check of the real behavior, not just
 *     the source text.
 *
 * Deliberately out of scope: changing hzl-service.js's/policy-ledger.js's
 * fallback itself. Production always runs with OPENCLAW_WORKSPACE set (see
 * server.js); the fix here is making tests hermetic, matching the existing
 * convention used by every e2e test that already spawns server.js with an
 * explicit workspace. /projects/ is also gitignored at the repo root now, as
 * a second line of defense for a test that forgets.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const DASHBOARD_DIR = __dirname;
const REPO_ROOT = path.resolve(DASHBOARD_DIR, '..');

// Any call into hzl-service.js that can create a task or project — these are
// the entry points that end up under PROJECTS_DIR (specs/_index.json) or
// append to the policy ledger (.audit/policy-ledger.jsonl).
const TASK_CREATION_CALL_RE = /\.createTask\(|\.createTaskWithPolicy\(|\.createTaskForMigration\(|\.createProject\(|workflowDelegate\(|workflowHandoff\(/;
const ENV_OVERRIDE_RE = /OPENCLAW_WORKSPACE|FLOWBOARD_POLICY_LEDGER_DIR|FLOWBOARD_PROJECTS_DIR/;
const HZL_REQUIRE_RE = /require\(\s*['"]\.\/hzl-service(?:\.js)?['"]\s*\)/;

// This test file itself, and its T-462 sibling, are expected to set the
// override — excluding them would be circular, so no exclusion list is
// needed; they are asserted like every other file.

function listTestFiles() {
  return fs.readdirSync(DASHBOARD_DIR)
    .filter(name => /^test-.*\.(js|mjs)$/.test(name));
}

function main() {
  // --- 1. Static guard: every hzl-service-requiring, task-creating test
  //        sets a workspace/projects/ledger override before the require. ---
  let checked = 0;
  const uncheckedButRequiring = [];
  for (const name of listTestFiles()) {
    const filePath = path.join(DASHBOARD_DIR, name);
    const source = fs.readFileSync(filePath, 'utf8');
    const requireMatch = HZL_REQUIRE_RE.exec(source);
    if (!requireMatch) continue; // doesn't touch hzl-service.js in-process
    if (!TASK_CREATION_CALL_RE.test(source)) {
      uncheckedButRequiring.push(name);
      continue; // no filesystem-touching call — nothing to leak
    }
    checked++;
    const beforeRequire = source.slice(0, requireMatch.index);
    assert.ok(ENV_OVERRIDE_RE.test(beforeRequire),
      `${name}: requires ./hzl-service.js and creates tasks/projects but does not set ` +
      'OPENCLAW_WORKSPACE (or FLOWBOARD_POLICY_LEDGER_DIR/FLOWBOARD_PROJECTS_DIR) before the ' +
      'require — this leaks into <repo>/projects/ whenever OPENCLAW_WORKSPACE is unset in the shell');
  }
  assert.ok(checked >= 10,
    `expected to check at least 10 task-creating, hzl-service-requiring test files, checked ${checked}`);
  console.log(`T-460 static workspace-isolation guard: ${checked} task-creating test file(s) checked ` +
    `(${uncheckedButRequiring.length} more require hzl-service.js without creating tasks/projects), ` +
    'all set an override before requiring hzl-service.js');

  // --- 2. Dynamic check: actually run a previously-leaking test and make
  //        sure <repo>/projects/ is untouched. -----------------------------
  const repoProjectsDir = path.join(REPO_ROOT, 'projects');
  const before = snapshotIfExists(repoProjectsDir);

  execFileSync(process.execPath, ['test-hzl-integration.js'], {
    cwd: DASHBOARD_DIR,
    stdio: 'pipe',
  });

  const after = snapshotIfExists(repoProjectsDir);
  assert.deepEqual(after, before,
    'running test-hzl-integration.js (the test that used PROJECT=\'test-project\' / \'other-project\' ' +
    'and originally leaked into <repo>/projects/) must not create or change <repo>/projects/');

  console.log('T-460 dynamic workspace-isolation check: test-hzl-integration.js left <repo>/projects/ untouched');
}

function snapshotIfExists(dir) {
  // A clean tree has no <repo>/projects/ at all (it's gitignored test junk
  // if present at all). Whether or not one happens to exist for other
  // reasons, this just proves the run under test didn't add or change
  // anything in it.
  if (!fs.existsSync(dir)) return null;
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else out.push(`${full}:${fs.statSync(full).mtimeMs}:${fs.statSync(full).size}`);
    }
  };
  walk(dir);
  return out.sort();
}

main();
console.log('T-460 workspace isolation tests: all passed');
