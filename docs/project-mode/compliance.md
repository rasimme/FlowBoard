# Compliance & Contract Monitoring

## Purpose

Monitoring and enforcement mechanisms for FlowBoard contract adherence. This covers agent handoff contracts, snippet size constraints, and task execution compliance.

## Snippet Size Compliance

### Minimal-Snippet Contract

AGENTS.md snippets must adhere to strict size and content constraints to remain useful as quick-load triggers.

**Constraints:**
- **Total size**: ≤ 30 lines
- **Forbidden content**: delegation endpoints, error handling, retry logic, HTTP details, JSON parsing instructions
- **Required content**: status check, active-project detection, rule pointers, bootstrap fetch

**Validation:**
- `snippets-doctor` runs at lint/CI time and reports violations
- The dashboard (`/api/snippets/status`) exposes compliance status per workspace
- Violations are surfaced as "Migration required" advisories

**Oversized Snippet Detection:**

If a snippet exceeds size limits or embeds prohibited detail, `snippets-doctor` flags it:

```
snippets-doctor —base ~/.openclaw
# Output:
[OVERSIZED] AGENTS.md in workspace contains embedded delegation endpoint list
[CONSTRAINT] Inline error-handling logic found (should be in rules/)
[DETAIL] Snippet is 47 lines, constraint is ≤30
```

### Common Violations

| Violation | Detection | Example | Fix |
|-----------|-----------|---------|-----|
| **Oversized** | Line count > 30 | 50+ line AGENTS.md with examples | Move details to rules/ |
| **Embedded endpoints** | Keywords: `/checkpoint`, `/complete`, `/workflows/start` | `POST /api/workflows/start` inline | Move to rules/agent-bridge |
| **Error handling** | Keywords: `retry`, `attempt`, `exponential backoff`, `never JSON.parse` | "Try 3 times with exponential backoff" | Move to rules/error-handling |
| **HTTP protocol** | Keywords: `Content-Type`, `Authorization`, `request body`, `response format` | "Content-Type: application/json" | Move to rules/api-access |
| **Stale contract** | Structural legacy markers present | `echo "$OPENCLAW_AGENT_ID"`, `BOOTSTRAP.md` | Migrate via `snippets-doctor --apply --migrate` |

### Running Compliance Checks

```bash
# Dry-run: detect violations
node snippets-doctor.js --base ~/.openclaw

# Apply safe migrations (byte-identical blocks only)
node snippets-doctor.js --base ~/.openclaw --apply

# Force-migrate drifted blocks with heuristic replacement
node snippets-doctor.js --base ~/.openclaw --apply --migrate

# Apply with no confirmation prompt
node snippets-doctor.js --base ~/.openclaw --apply --yes
```

## Task Execution Compliance

### Routed-Unclaimed Detection

When an agent is routed (soft-assigned) to a task but fails to claim it, the task enters a suspicious state.

**Root Causes:**
1. Agent received route notification but crashed before claiming
2. Agent routing happened but agent never started
3. Handoff contract not followed (agent didn't call startup steps)
4. Dependency resolution failed (task cannot be claimed until dependencies complete)

**Detection:**
```
GET /api/tasks/stuck
```

The endpoint is cross-project; filter by `project` in the response if needed.

### Checkpoint Health

Tasks with infrequent checkpoints indicate potential stalling or agent disconnection.

**Thresholds:**
- **Stale**: ≥30 minutes since last checkpoint (default threshold)
- **Stuck**: ≥60 minutes, no recent activity
- **Expired lease**: Lease end-time in the past

**Monitoring:**
```bash
curl -s http://127.0.0.1:18790/api/tasks/stuck | jq '.stuck'
```

## Compliance Reporting

### Dashboard Status Endpoint

```
GET /api/snippets/status
```

Returns real-time compliance status across all workspaces when compliance is OK, `chip` is `null` and files list is empty.

## Compliance Enforcement

### CI Integration

Add to your CI pipeline:

```bash
# Fail if any snippets are non-current
node dashboard/snippets-doctor.js --base ~/.openclaw
if [ $? -ne 0 ]; then
  echo "❌ Snippets out of compliance. Run snippets-doctor --apply --migrate to fix."
  exit 1
fi

# Run compliance tests
node dashboard/test-compliance-detection.js
```

## Troubleshooting

### Snippet Not Migrating

**Symptom:**
```
snippets-doctor --base ~/.openclaw --apply --migrate
# Output: [DRIFT-REGION-NOT-FOUND] drift-region-not-found
```

**Cause:** User edited the drifted snippet in a way that heuristic heading-matching can't locate the snippet block.

**Fix:** Manual merge required.

### Stale OpenClaw Configuration

**Symptom:**
```
snippets-doctor --base ~/.openclaw
# Advisory: openclaw.json is API-first, but gateway was started before config changed
```

**Fix:** Restart OpenClaw gateway so new sessions pick up the updated config.
