'use strict';

const IMPORT_JOURNAL_STATES = Object.freeze({
  VALIDATING: 'validating',
  STAGING: 'staging',
  CREATING_PROJECT: 'creating-project',
  IMPORTING_TASKS: 'importing-tasks',
  IMPORTING_FILES: 'importing-files',
  IMPORTING_CANVAS: 'importing-canvas',
  VERIFYING: 'verifying',
  COMMITTED: 'committed',
  FAILED: 'failed',
  CLEANING: 'cleaning',
  CLEANED: 'cleaned',
});

const HAPPY_PATH = Object.freeze([
  IMPORT_JOURNAL_STATES.VALIDATING,
  IMPORT_JOURNAL_STATES.STAGING,
  IMPORT_JOURNAL_STATES.CREATING_PROJECT,
  IMPORT_JOURNAL_STATES.IMPORTING_TASKS,
  IMPORT_JOURNAL_STATES.IMPORTING_FILES,
  IMPORT_JOURNAL_STATES.IMPORTING_CANVAS,
  IMPORT_JOURNAL_STATES.VERIFYING,
  IMPORT_JOURNAL_STATES.COMMITTED,
]);

const ACTIVE_STATES = new Set(HAPPY_PATH.slice(0, -1));
const TRANSITIONS = new Map(HAPPY_PATH.slice(0, -1).map((state, index) => [
  state,
  new Set([HAPPY_PATH[index + 1], IMPORT_JOURNAL_STATES.FAILED]),
]));
TRANSITIONS.set(IMPORT_JOURNAL_STATES.FAILED,
  new Set([IMPORT_JOURNAL_STATES.STAGING, IMPORT_JOURNAL_STATES.CLEANING]));
TRANSITIONS.set(IMPORT_JOURNAL_STATES.CLEANING,
  new Set([IMPORT_JOURNAL_STATES.CLEANED, IMPORT_JOURNAL_STATES.FAILED]));
TRANSITIONS.set(IMPORT_JOURNAL_STATES.COMMITTED, new Set());
TRANSITIONS.set(IMPORT_JOURNAL_STATES.CLEANED, new Set());

function isJournalState(state) {
  return Object.values(IMPORT_JOURNAL_STATES).includes(state);
}

function canTransitionImportJournal(from, to) {
  return isJournalState(from) && isJournalState(to) && TRANSITIONS.get(from)?.has(to) === true;
}

function assertImportJournalTransition(from, to) {
  if (!canTransitionImportJournal(from, to)) {
    throw Object.assign(new Error(`Invalid project import transition: ${from} -> ${to}`), {
      code: 'IMPORT_JOURNAL_TRANSITION_INVALID',
      from,
      to,
    });
  }
}

function recoveryDisposition(state) {
  if (state === IMPORT_JOURNAL_STATES.COMMITTED || state === IMPORT_JOURNAL_STATES.CLEANED) return 'none';
  if (state === IMPORT_JOURNAL_STATES.FAILED) return 'resume-or-cleanup';
  if (state === IMPORT_JOURNAL_STATES.CLEANING) return 'cleanup';
  if (ACTIVE_STATES.has(state)) return 'mark-failed';
  return 'invalid';
}

function importedProjectIsVisible(state) {
  return state === IMPORT_JOURNAL_STATES.COMMITTED;
}

function importLockKey(targetProject) {
  if (typeof targetProject !== 'string' || !/^[a-z0-9][a-z0-9-]*$/.test(targetProject)) {
    throw Object.assign(new Error('Invalid target project for import lock'), { code: 'IMPORT_TARGET_INVALID' });
  }
  return `project-import:${targetProject}`;
}

module.exports = {
  ACTIVE_STATES,
  HAPPY_PATH,
  IMPORT_JOURNAL_STATES,
  assertImportJournalTransition,
  canTransitionImportJournal,
  importedProjectIsVisible,
  importLockKey,
  isJournalState,
  recoveryDisposition,
};
