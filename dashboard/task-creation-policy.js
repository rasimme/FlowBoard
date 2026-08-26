'use strict';

/**
 * T-447-3: narrow, server-context task-creation policy.
 *
 * This is intentionally not a general policy engine.  It evaluates only the
 * four operational exceptions named by the parent task and the normal
 * Specify/tasks-api paths.  `context` is supplied by trusted server callers;
 * request-body claims must never be copied into it.
 */

const EXCEPTION_TYPES = Object.freeze([
  'handoff',
  'delegate_subtask',
  'incident',
]);

const DECISIONS = Object.freeze(['allowed', 'blocked']);

function isVerifiedHuman(principal) {
  return principal?.kind === 'human' && principal.verified === true;
}

function nonEmpty(value) {
  return typeof value === 'string' && value.trim().length > 0;
}

function sourceIdOf(context) {
  return context.sourceTaskId || context.fromTaskId || null;
}

function sourceIdsConflict(context) {
  if (context.sourceTaskId == null || context.fromTaskId == null) return false;
  return String(context.sourceTaskId) !== String(context.fromTaskId);
}

function evidenceOf(context) {
  return context.humanEvidence || context.humanRequestEvidence || null;
}

function hasOneTopLevelAction(opts, context) {
  if (opts.parentId !== undefined && opts.parentId !== null) return false;
  if (context.topLevelAction === false) return false;
  const actionLists = [context.topLevelActions, context.actions, context.topLevelTasks]
    .filter(Array.isArray);
  if (actionLists.some(actions => actions.length !== 1)) return false;
  if (actionLists.some(actions => actions.some(action =>
    action && typeof action === 'object' && action.parentId !== undefined && action.parentId !== null))) {
    return false;
  }
  if (Array.isArray(context.taskBreakdown)) {
    const topLevel = context.taskBreakdown.filter(action =>
      !action || typeof action !== 'object' || (action.role !== 'subtask' && action.parentId == null));
    if (topLevel.length !== 1 || context.taskBreakdown.length !== 1) return false;
  }
  if (context.actionCount !== undefined && context.actionCount !== 1) return false;
  if (context.taskCount !== undefined && context.taskCount !== 1) return false;
  return true;
}

function specifyConfirmationIsValid(record) {
  return !!record
    && nonEmpty(record.actor)
    && nonEmpty(record.confirmedAt)
    && nonEmpty(record.specifySessionId)
    && nonEmpty(record.proposalBoundAt)
    && Number.isInteger(record.proposalVersion)
    && record.proposalVersion >= 1
    && nonEmpty(record.proposalIdentity?.digest);
}

function inferException(context = {}) {
  if (Object.prototype.hasOwnProperty.call(context, 'exception')) {
    return context.exception;
  }
  if (context.origin === 'handoff') return 'handoff';
  if (context.origin === 'delegate_subtask') return 'delegate_subtask';
  if (context.origin === 'incident') return 'incident';
  if (context.origin === 'human_requested_trivial') return 'human_requested_trivial';
  // `delegate` is the historical internal origin. It is an exception only
  // when it creates the exact child relationship; noDepends remains ordinary
  // work and therefore is never inferred as delegate_subtask.
  if (context.origin === 'delegate' && context.noDepends !== true) return 'delegate_subtask';
  return null;
}

function result(decision, code, reason, context, exception = null, extra = {}) {
  return {
    decision,
    code,
    reason,
    origin: context.origin || null,
    exception,
    sourceTaskId: sourceIdOf(context),
    principal: context.principal || null,
    evidence: evidenceOf(context),
    ...extra,
  };
}

/**
 * Evaluate a server-supplied creation context.
 *
 * `getTask(project, id)` must be the live HZL-backed lookup.  Returning a
 * task-shaped object supplied by a request would defeat the source predicate.
 */
function evaluateCreationPolicy({ project, opts = {}, context = {}, getTask }) {
  const origin = typeof context.origin === 'string' ? context.origin.trim() : '';
  if (!origin) return result('blocked', 'CREATION_ORIGIN_REQUIRED', 'Task creation origin is required', context);

  const supportedOrigins = new Set([
    'tasks-api', 'specify', 'handoff', 'delegate', 'delegate_subtask',
    'incident', 'human_requested_trivial', 'migration',
  ]);
  if (!supportedOrigins.has(origin)) {
    return result('blocked', 'CREATION_ORIGIN_INVALID', `Invalid task creation origin: "${origin}"`, context);
  }

  if (origin === 'migration') {
    return result('allowed', 'MIGRATION_ALLOWED', 'Explicit migration/import path', context);
  }

  const exception = inferException(context);
  if (exception !== null && !EXCEPTION_TYPES.includes(exception)) {
    return result('blocked', 'EXCEPTION_INVALID', `Invalid creation exception: "${exception}"`, context);
  }

  // `delegate` is an internal workflow origin.  If it is used for a child
  // operation, both source fields must describe the same live source before
  // any exception predicate is evaluated.  This also prevents an explicit
  // null exception from turning a malformed delegation into an ordinary
  // compatibility-mode creation.
  if (origin === 'delegate' && context.noDepends !== true && sourceIdsConflict(context)) {
    return result('blocked', 'DELEGATE_SOURCE_CONFLICT', 'Delegation sourceTaskId and fromTaskId must identify the same task', context, exception);
  }

  if (origin === 'specify') return result('allowed', 'SPECIFY_ALLOWED', 'Specify creation is allowed', context);

  // A noDepends delegation deliberately has no exception. Per ADR-0035, task
  // form is not authorization: direct creation is allowed once the shape
  // checks above pass, and Specify remains an optional workflow rather than
  // a creation gate.
  if (origin === 'delegate' && context.noDepends === true) {
    if (sourceIdsConflict(context)) {
      return result('blocked', 'DELEGATE_SOURCE_CONFLICT', 'Delegation sourceTaskId and fromTaskId must identify the same task', context);
    }
    if (opts.parentId !== undefined && opts.parentId !== null) {
      return result('blocked', 'NO_DEPENDS_PARENT_CONFLICT', 'noDepends delegation must be top-level with parentId null', context);
    }
    if (context.exception !== undefined && context.exception !== null) {
      return result('blocked', 'NO_DEPENDS_NOT_EXCEPTION', 'Top-level noDepends delegation is not a delegate_subtask exception', context, context.exception);
    }
    return result('allowed', 'NO_DEPENDS_ALLOWED', 'Top-level delegation without a parent dependency is allowed', context);
  }

  if (exception === null) {
    if (origin === 'tasks-api' || origin === 'delegate') {
      return result('allowed', 'DIRECT_CREATION_ALLOWED', 'Direct task creation is allowed; Specify is optional', context);
    }
    return result('blocked', 'EXCEPTION_REQUIRED', 'This creation path requires a validated exception', context);
  }

  const sourceTaskId = sourceIdOf(context);
  if (exception === 'delegate_subtask' && sourceIdsConflict(context)) {
    return result('blocked', 'DELEGATE_SOURCE_CONFLICT', 'Delegation sourceTaskId and fromTaskId must identify the same task', context, exception);
  }
  const getLiveTask = typeof getTask === 'function' && sourceTaskId
    ? getTask(project, sourceTaskId)
    : null;

  if (exception === 'handoff') {
    if (!getLiveTask) return result('blocked', 'HANDOFF_SOURCE_NOT_FOUND', 'Handoff source task does not exist', context, exception);
    if (getLiveTask.status !== 'in-progress') {
      return result('blocked', 'HANDOFF_SOURCE_NOT_IN_PROGRESS', 'Handoff source task must be in-progress', context, exception);
    }
    return result('allowed', 'HANDOFF_VALID', 'Handoff source is a real in-progress task', context, exception);
  }

  if (exception === 'delegate_subtask') {
    if (context.noDepends === true) {
      if (opts.parentId !== undefined && opts.parentId !== null) {
        return result('blocked', 'NO_DEPENDS_PARENT_CONFLICT', 'noDepends delegation must be top-level with parentId null', context, exception);
      }
      return result('blocked', 'NO_DEPENDS_NOT_EXCEPTION', 'Top-level noDepends delegation is not a delegate_subtask exception', context, exception);
    }
    if (!getLiveTask) return result('blocked', 'DELEGATE_SOURCE_NOT_FOUND', 'Delegation source task does not exist', context, exception);
    if (opts.parentId !== sourceTaskId) {
      return result('blocked', 'DELEGATE_PARENT_MISMATCH', 'Delegated task parentId must equal fromTaskId', context, exception);
    }
    return result('allowed', 'DELEGATE_SUBTASK_VALID', 'Delegated task has the exact source parent', context, exception);
  }

  if (exception === 'incident') {
    const incidentRef = context.incidentRef || context.incidentReference || context.reference;
    if (!nonEmpty(incidentRef)) {
      return result('blocked', 'INCIDENT_REFERENCE_REQUIRED', 'Incident exception requires a non-empty reference', context, exception);
    }
    return result('allowed', 'INCIDENT_VALID', 'Incident reference is present', context, exception, { incidentRef: incidentRef.trim() });
  }

  return result('blocked', 'EXCEPTION_UNHANDLED', 'Creation exception is not supported', context, exception);
}

module.exports = {
  DECISIONS,
  EXCEPTION_TYPES,
  evaluateCreationPolicy,
  hasOneTopLevelAction,
  specifyConfirmationIsValid,
};
