'use strict';

/**
 * T-447-3: append-only task-creation policy ledger.
 *
 * The ledger is deliberately a small JSONL file rather than a mutable task
 * field.  It records both decisions which create a task and decisions which
 * reject a request, so a blocked request is still explainable.  The file is
 * kept in the shared audit directory (outside a project file tree) and each
 * append is flushed before the call returns.
 */

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DECISIONS = Object.freeze(['allowed', 'blocked']);

function defaultAuditDir() {
  if (process.env.FLOWBOARD_POLICY_LEDGER_DIR) {
    return path.resolve(process.env.FLOWBOARD_POLICY_LEDGER_DIR);
  }
  const projectsDir = process.env.FLOWBOARD_PROJECTS_DIR
    || path.join(process.env.OPENCLAW_WORKSPACE || path.resolve(__dirname, '..'), 'projects');
  return path.join(path.resolve(projectsDir), '.audit');
}

function ledgerPath(options = {}) {
  const dir = options.dir || defaultAuditDir();
  return path.join(path.resolve(dir), 'policy-ledger.jsonl');
}

function clone(value) {
  if (value === undefined || value === null) return value;
  return JSON.parse(JSON.stringify(value));
}

function appendPolicyRecord(project, record = {}, options = {}) {
  const decision = record.decision;
  if (!DECISIONS.includes(decision)) {
    throw Object.assign(new Error(`Invalid policy decision: ${decision}`), {
      code: 'POLICY_DECISION_INVALID', status: 400,
    });
  }
  if (typeof project !== 'string' || !project.trim()) {
    throw Object.assign(new Error('Policy ledger project is required'), {
      code: 'POLICY_LEDGER_PROJECT_REQUIRED', status: 400,
    });
  }

  const entry = {
    version: 1,
    id: typeof record.id === 'string' && record.id ? record.id : crypto.randomUUID(),
    recordedAt: typeof record.recordedAt === 'string' && record.recordedAt
      ? record.recordedAt : new Date().toISOString(),
    project: project.trim(),
    decision,
    origin: record.origin || null,
    exception: record.exception || null,
    taskId: record.taskId || null,
    sourceTaskId: record.sourceTaskId || null,
    reason: record.reason || null,
    code: record.code || null,
    principal: record.principal ? clone(record.principal) : null,
    evidence: record.evidence ? clone(record.evidence) : null,
    // Observation telemetry for the rollout: every decision can be grouped
    // by the persisted mode that evaluated it. Older records may omit this
    // field; new records always carry the normalized compatibility value.
    governanceMode: record.governanceMode === 'enforce' ? 'enforce' : 'compat',
  };

  const file = ledgerPath(options);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(file, fs.constants.O_APPEND | fs.constants.O_CREAT | fs.constants.O_WRONLY, 0o600);
  const previousSize = fs.fstatSync(fd).size;
  try {
    const encodedRecord = `${JSON.stringify(entry)}\n`;
    const expectedBytes = Buffer.byteLength(encodedRecord, 'utf8');
    const writtenBytes = fs.writeSync(fd, encodedRecord, null, 'utf8');
    if (writtenBytes !== expectedBytes) {
      throw Object.assign(new Error(
        `Policy ledger short write: expected ${expectedBytes} bytes, wrote ${writtenBytes}`
      ), {
        code: 'POLICY_LEDGER_SHORT_WRITE',
        expectedBytes,
        writtenBytes,
      });
    }
    fs.fsyncSync(fd);
  } catch (error) {
    // A write can fail after appending bytes (notably a deterministic fsync
    // failure in tests or a full filesystem). Restore the exact pre-append
    // length before surfacing the error so a partial policy record can never
    // be mistaken for durable audit evidence.
    try {
      fs.ftruncateSync(fd, previousSize);
      fs.fsyncSync(fd);
    } catch (rollbackError) {
      error.ledgerRollbackError = rollbackError.message;
    }
    throw error;
  } finally {
    fs.closeSync(fd);
  }
  return Object.freeze(entry);
}

function readPolicyLedger(options = {}) {
  const file = ledgerPath(options);
  if (!fs.existsSync(file)) return [];
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  return lines.map(line => JSON.parse(line));
}

module.exports = { DECISIONS, ledgerPath, appendPolicyRecord, readPolicyLedger };
