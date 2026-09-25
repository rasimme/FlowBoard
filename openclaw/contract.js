/**
 * FlowBoard feature contract (T-487-7; stage 1 T-487-8, stage 2 T-498,
 * native editing T-499).
 *
 * One declaration of the operations FlowBoard exposes inside an OpenClaw
 * Gateway. The host validates every input and output against these schemas,
 * enforces `operator.read` on queries and `operator.write` on actions, and
 * serves the same operations to the native Control UI and to plugin command /
 * session-action callers. See ADR-0040.
 *
 * Schemas are plain JSON Schema object literals rather than TypeBox builders.
 * The host normalizes JSON Schema for TypeBox before compiling a validator
 * (`openclaw/dist/schema-validator-*.mjs` → `normalizeJsonSchemaForTypeBox` +
 * `Compile`), so a literal is validated identically while FlowBoard keeps a
 * dependency-free plugin root and a small browser bundle. Every string and
 * array is bounded; the Gateway rejects anything larger before a handler runs.
 */
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

/** Mirrors the dashboard's task status vocabulary (hzl-service VALID_STATUSES). */
export const TASK_STATUSES = ['backlog', 'open', 'in-progress', 'review', 'done', 'archived'];
export const TASK_PRIORITIES = ['low', 'medium', 'high'];
/** The canonical work state beside the lifecycle status (ADR-0031, work-state.js). */
export const TASK_WORK_STATES = ['working', 'waiting', 'blocked', 'paused'];

/**
 * Why a task is on the operator's plate. `review` is FlowBoard's approve gate
 * (a human decides), `blocked` is the canonical work state (ADR-0031), and
 * `stuck` is the live stall detection behind `GET /api/tasks/stuck` — stale
 * checkpoints, expired leases, routed-but-unclaimed work, a due re-check, or
 * an explicit `waiting` state.
 */
export const NEEDS_ME_REASONS = ['review', 'blocked', 'stuck'];

export const MAX_PROJECTS = 200;
export const MAX_TASKS = 500;
/** Hard ceiling on one "needing me" answer — a rail, not a board. */
export const MAX_NEEDS_ME = 100;
export const DEFAULT_NEEDS_ME_LIMIT = 40;

/** One board page. Above this the client asks for a status instead (T-498). */
export const DEFAULT_TASK_LIST_LIMIT = 300;
/** Tag bounds: FlowBoard has no hard limit, the wire does. */
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
/** The detail panel reads the newest slice, never the whole history. */
export const MAX_COMMENTS = 20;
export const MAX_CHECKPOINTS = 10;
/**
 * FlowBoard's own description limit (16 KB, server.js T-396), so an edit made
 * in the native panel round-trips losslessly. Larger legacy descriptions are
 * still cut on read and flagged, and a client must not save a cut one back.
 */
export const MAX_DESCRIPTION = 16384;
/** One comment, in both directions: `task.comment` input and `task.get` output. */
export const MAX_COMMENT = 2000;
/** An edited title. Creation keeps FlowBoard's stricter 128 (`task.create`). */
export const MAX_TITLE = 200;
/** An approve/reject note is one paragraph of evidence, not a document. */
export const MAX_REASON = 500;
/** `tasks-changed.ids` is a hint; a bigger diff is sent without ids at all. */
export const MAX_CHANGED_IDS = 50;
/** One work-state detail field (work-state.js keeps them short and factual). */
export const MAX_DETAIL_LENGTH = 200;

const object = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

const EMPTY_INPUT = object({});
const projectName = { type: 'string', minLength: 1, maxLength: 64 };
const agentId = { type: 'string', minLength: 1, maxLength: 64 };
const sessionKey = { type: 'string', minLength: 1, maxLength: 256 };
const nullableString = (maxLength) => ({
  anyOf: [{ type: 'string', minLength: 1, maxLength }, { type: 'null' }],
});

/**
 * Which layer answered a status read: the session binding, the agent-level
 * binding, or neither (T-487-2 / ADR-0039). FlowBoard reports it on both
 * `/api/status` verbs; the native UI shows it so an operator can tell a
 * session-scoped project from an agent-wide one.
 */
const bindingScope = { anyOf: [{ type: 'string', enum: ['session', 'agent'] }, { type: 'null' }] };

const binding = object(
  {
    agentId: { type: 'string', maxLength: 64 },
    contextReady: { type: 'boolean' },
    sessionKey: nullableString(256),
    scope: bindingScope,
  },
  ['agentId', 'contextReady', 'sessionKey', 'scope'],
);

/**
 * The card the native board renders (T-498).
 *
 * One Task shape for every operation that returns a task — the list, the
 * detail read, and each write action that answers with a task — so a client can replace a
 * card with the result of an action without a second fetch or a second parser.
 *
 * It is FlowBoard's own projection, bounded and narrowed: every field below
 * comes from `GET /api/projects/:name/tasks`, nothing is derived here, and the
 * fields FlowBoard exposes but a board does not draw (claim timestamps,
 * checkpoint counters, exception/structure review markers, trash state,
 * dependencies) stay out. Narrowing is the point: the Gateway validates this
 * schema on the way out, so anything not listed here cannot reach an
 * unsandboxed browser bundle by accident.
 */
const workStateDetails = object({
  reason: nullableString(MAX_DETAIL_LENGTH),
  waitingFor: nullableString(MAX_DETAIL_LENGTH),
  responsible: nullableString(MAX_DETAIL_LENGTH),
  // FlowBoard requires a full ISO-8601 date-time *with* an explicit timezone
  // here (work-state.js `isValidDateString`) and answers a bad one with its
  // own 400; the wire only bounds the length. The same shape is the input of
  // `task.update`, so a client round-trips what it read.
  checkAgainAt: nullableString(64),
});

/**
 * FlowBoard's live stall detection for one task, reduced to what a chip shows.
 *
 * The stored indicator carries a dozen fields — delivery routing, wake agent,
 * owner kind, the available actions. A board needs to say *that* something is
 * stalled, *why*, and *since when*; the rest is operational routing that
 * belongs to FlowBoard's own notifier, not to the Control UI.
 */
const stuckIndicator = object({
  active: { type: 'boolean' },
  reason: nullableString(32),
  message: nullableString(MAX_DETAIL_LENGTH),
  /** When the condition started (last checkpoint / lease end). */
  since: nullableString(64),
  /** When FlowBoard first noticed this incident. */
  detectedAt: nullableString(64),
});

const taskFields = {
  id: { type: 'string', maxLength: 64 },
  title: { type: 'string', maxLength: 256 },
  status: { type: 'string', enum: TASK_STATUSES },
  workState: { type: 'string', enum: TASK_WORK_STATES },
  workStateDetails,
  stuckIndicator: { anyOf: [stuckIndicator, { type: 'null' }] },
  priority: { type: 'string', enum: TASK_PRIORITIES },
  agent: nullableString(64),
  parentId: nullableString(64),
  subtaskCount: { type: 'integer', minimum: 0, maximum: MAX_TASKS },
  tags: { type: 'array', maxItems: MAX_TAGS, items: { type: 'string', maxLength: MAX_TAG_LENGTH } },
  /** Manual per-column rank (T-130); null means "unranked, sort by id". */
  order: { anyOf: [{ type: 'number' }, { type: 'null' }] },
  enteredStatusAt: nullableString(64),
  created: nullableString(64),
  leaseUntil: nullableString(64),
  specExists: { type: 'boolean' },
};

/**
 * `workStateDetails` and `stuckIndicator` are deliberately *not* required:
 * they are always sent, but leaving them optional means a client written
 * against `task.workStateDetails?.reason` stays correct if a later stage ever
 * drops them from a projection.
 */
const TASK_REQUIRED = [
  'id', 'title', 'status', 'workState', 'priority', 'agent', 'parentId', 'subtaskCount',
  'tags', 'order', 'enteredStatusAt', 'created', 'leaseUntil', 'specExists',
];

const task = object(taskFields, TASK_REQUIRED);

const taskResult = object({ task }, ['task']);

const taskId = { type: 'string', minLength: 1, maxLength: 64 };
const reason = { type: 'string', minLength: 1, maxLength: MAX_REASON };

/**
 * One comment as `task.get` lists it and `task.comment` answers it (T-499),
 * so a panel can append the answer of a write to the list it already shows.
 */
const comment = object(
  {
    /** FlowBoard's event row id — an integer, null for a few legacy rows. */
    id: { anyOf: [{ type: 'integer', minimum: 0 }, { type: 'null' }] },
    author: nullableString(128),
    message: { type: 'string', maxLength: MAX_COMMENT },
    /** 'question' | 'answer' for typed comments (T-307), else null. */
    kind: nullableString(16),
    timestamp: nullableString(64),
  },
  ['id', 'author', 'message', 'kind', 'timestamp'],
);

export const contract = defineFeatureContract({
  pluginId: 'flowboard',
  operations: {
    'ui.config': {
      kind: 'query',
      description: 'Resolve the FlowBoard dashboard base URL configured for this Gateway.',
      input: EMPTY_INPUT,
      output: object({ dashboardUrl: { type: 'string', minLength: 1, maxLength: 2048 } }, ['dashboardUrl']),
    },
    'projects.list': {
      kind: 'query',
      description: 'List FlowBoard projects with their lifecycle status and attention counts.',
      input: EMPTY_INPUT,
      output: object(
        {
          projects: {
            type: 'array',
            maxItems: MAX_PROJECTS,
            items: object(
              {
                name: { type: 'string', maxLength: 64 },
                status: { type: 'string', maxLength: 32 },
                // Already part of GET /api/projects, so these cost nothing
                // extra and let the switcher mark where work is waiting.
                counts: object(
                  {
                    review: { type: 'integer', minimum: 0 },
                    blocked: { type: 'integer', minimum: 0 },
                  },
                  ['review', 'blocked'],
                ),
              },
              ['name', 'status', 'counts'],
            ),
          },
        },
        ['projects'],
      ),
    },
    'status.get': {
      kind: 'query',
      description: 'Read the FlowBoard project an agent or one of its sessions is currently bound to.',
      input: object({ agentId, sessionKey }, ['agentId']),
      output: object({ activeProject: nullableString(64), binding }, ['activeProject', 'binding']),
    },
    'tasks.list': {
      kind: 'query',
      description:
        'List the tasks of one FlowBoard project as board cards, ordered by the manual column rank and then by id. ' +
        'Archived tasks are excluded unless includeArchived is set; asking for status "archived" includes them implicitly, ' +
        'because the query would otherwise be empty by definition. Tasks in the Trash are never listed.',
      input: object(
        {
          project: projectName,
          status: { type: 'string', enum: TASK_STATUSES },
          includeArchived: { type: 'boolean' },
          limit: { type: 'integer', minimum: 1, maximum: MAX_TASKS },
        },
        ['project'],
      ),
      output: object(
        {
          tasks: { type: 'array', maxItems: MAX_TASKS, items: task },
          /** True when the limit cut the board short — the client may narrow by status. */
          truncated: { type: 'boolean' },
        },
        ['tasks', 'truncated'],
      ),
    },
    'task.get': {
      kind: 'query',
      description:
        'Read one task with the fields a detail panel needs: the card, its description and spec link, ' +
        'its newest comments and its newest checkpoints. Long descriptions are truncated and say so.',
      input: object({ project: projectName, id: taskId }, ['project', 'id']),
      output: object(
        {
          task: object(
            {
              ...taskFields,
              description: { type: 'string', maxLength: MAX_DESCRIPTION },
              /** The description was longer than MAX_DESCRIPTION and was cut. */
              descriptionTruncated: { type: 'boolean' },
              /** Project-relative path of the linked spec, or null (see specExists). */
              specFile: nullableString(512),
            },
            [...TASK_REQUIRED, 'description', 'descriptionTruncated', 'specFile'],
          ),
          comments: { type: 'array', maxItems: MAX_COMMENTS, items: comment },
          checkpoints: {
            type: 'array',
            maxItems: MAX_CHECKPOINTS,
            items: object(
              {
                message: { type: 'string', maxLength: 256 },
                agent: nullableString(64),
                progress: { anyOf: [{ type: 'number' }, { type: 'null' }] },
                timestamp: nullableString(64),
              },
              ['message', 'agent', 'progress', 'timestamp'],
            ),
          },
        },
        ['task', 'comments', 'checkpoints'],
      ),
    },
    // Operation ids are lower-case by host rule (`^[a-z][a-z0-9._-]{0,127}$`
    // in the SDK's `defineFeatureContract`), so this is `needing-me`, not
    // `needingMe`.
    'tasks.needing-me': {
      kind: 'query',
      description:
        'List the tasks waiting on the operator: the review lane plus blocked and stalled work, across projects or in one project.',
      input: object(
        {
          project: projectName,
          limit: { type: 'integer', minimum: 1, maximum: MAX_NEEDS_ME },
        },
        [],
      ),
      output: object(
        {
          items: {
            type: 'array',
            maxItems: MAX_NEEDS_ME,
            items: object(
              {
                project: { type: 'string', maxLength: 64 },
                id: { type: 'string', maxLength: 64 },
                title: { type: 'string', maxLength: 256 },
                status: { type: 'string', maxLength: 32 },
                workState: { type: 'string', maxLength: 32 },
                reason: { type: 'string', enum: NEEDS_ME_REASONS },
                agent: nullableString(64),
                /** One short line of evidence, already bounded by the adapter. */
                note: nullableString(120),
              },
              ['project', 'id', 'title', 'status', 'workState', 'reason', 'agent', 'note'],
            ),
          },
          /** True when the limit or a scan bound cut the answer short. */
          truncated: { type: 'boolean' },
          /** How many projects were read for the review lane. */
          scannedProjects: { type: 'integer', minimum: 0, maximum: MAX_PROJECTS },
        },
        ['items', 'truncated', 'scannedProjects'],
      ),
    },
    'status.set': {
      kind: 'action',
      description: 'Bind an agent or one of its sessions to a FlowBoard project, or clear it with project: null.',
      input: object({ agentId, project: { anyOf: [projectName, { type: 'null' }] }, sessionKey }, [
        'agentId',
        'project',
      ]),
      output: object({ activeProject: nullableString(64), binding }, ['activeProject', 'binding']),
    },
    'task.create': {
      kind: 'action',
      description: 'Create a FlowBoard task in a project and return its id.',
      input: object(
        {
          project: projectName,
          title: { type: 'string', minLength: 1, maxLength: 128 },
          description: { type: 'string', maxLength: 16384 },
          priority: { type: 'string', enum: TASK_PRIORITIES },
        },
        ['project', 'title'],
      ),
      output: object({ id: { type: 'string', maxLength: 64 } }, ['id']),
    },
    'task.update': {
      kind: 'action',
      description:
        'Change a task (PUT /api/projects/:project/tasks/:id): its lifecycle status, its canonical work state, and ' +
        'its editable card fields — title, description, priority, tags and the manual column rank (order, null ' +
        'clears it). At least one field besides project and id is required; only the fields sent are changed. ' +
        'Archiving is status "archived" (from done) and unarchiving is status "done". FlowBoard authorizes the ' +
        'transition itself: review -> done and reopening a done task are refused here and belong to task.approve / ' +
        'an explicit reopen, and a task another agent is actively holding may not be moved from outside. ' +
        'workStateDetails is passed through unchanged; clearing a field means sending it as null.',
      input: object(
        {
          project: projectName,
          id: taskId,
          status: { type: 'string', enum: TASK_STATUSES },
          workState: { type: 'string', enum: TASK_WORK_STATES },
          workStateDetails,
          title: { type: 'string', minLength: 1, maxLength: MAX_TITLE },
          description: { type: 'string', maxLength: MAX_DESCRIPTION },
          priority: { type: 'string', enum: TASK_PRIORITIES },
          tags: {
            type: 'array',
            maxItems: MAX_TAGS,
            items: { type: 'string', minLength: 1, maxLength: MAX_TAG_LENGTH },
          },
          order: { anyOf: [{ type: 'number' }, { type: 'null' }] },
        },
        ['project', 'id'],
      ),
      output: taskResult,
    },
    'task.approve': {
      kind: 'action',
      description:
        'Accept a task that is in review and finalise it (POST /api/projects/:project/tasks/:id/approve): review -> done, ' +
        'plus an audit comment naming who approved it and why. Refused with NOT_IN_REVIEW when the task is in any other ' +
        'status. The approver is the Gateway-verified operator behind the call, never a value the client supplies.',
      input: object({ project: projectName, id: taskId, reason: { type: 'string', maxLength: MAX_REASON } }, [
        'project',
        'id',
      ]),
      output: taskResult,
    },
    'task.reject': {
      kind: 'action',
      description:
        'Send a task that is in review back to actionable work (POST /api/projects/:project/tasks/:id/reject): ' +
        'review -> in-progress, work state untouched, plus an audit comment carrying the reason. The reason is ' +
        'required — FlowBoard refuses a rejection without one — and is what the assignee reads. Refused with ' +
        'NOT_IN_REVIEW when the task is in any other status.',
      input: object({ project: projectName, id: taskId, reason }, ['project', 'id', 'reason']),
      output: taskResult,
    },
    'task.comment': {
      kind: 'action',
      description:
        'Add a comment to a task (POST /api/projects/:project/tasks/:id/comment) and return it as task.get lists ' +
        'comments. The author is the Gateway-verified operator behind the call, never a value the client supplies.',
      input: object(
        { project: projectName, id: taskId, message: { type: 'string', minLength: 1, maxLength: MAX_COMMENT } },
        ['project', 'id', 'message'],
      ),
      output: object({ comment }, ['comment']),
    },
    'task.trash': {
      kind: 'action',
      description:
        'Move a task to the FlowBoard Trash, or restore it with restore: true (PUT trashedAt on the task; the ' +
        'timestamp is made by the Gateway). A trashed task leaves tasks.list. Soft delete only: permanent deletion ' +
        'and emptying the Trash need FlowBoard\'s typed confirmation and are not part of this contract.',
      input: object({ project: projectName, id: taskId, restore: { type: 'boolean' } }, ['project', 'id']),
      output: object({ id: { type: 'string', maxLength: 64 }, trashed: { type: 'boolean' } }, ['id', 'trashed']),
    },
    'ui.focus': {
      kind: 'action',
      description:
        'Record which project this Control UI connection is looking at, so the background change poll watches that ' +
        'board and only that board. Sending null clears the focus. It stores nothing about the operator and writes ' +
        'nothing to FlowBoard; it is an action rather than a query because it mutates per-connection server state.',
      input: object({ project: { anyOf: [projectName, { type: 'null' }] } }, ['project']),
      output: object({ ok: { type: 'boolean' } }, ['ok']),
    },
  },
  events: {
    // Event ids may not contain dots (the SDK enforces /^[a-z][a-z0-9_-]{0,127}$/u
    // on events while operation ids allow them), so these use hyphens.
    'projects-changed': EMPTY_INPUT,
    // `project` is optional: an action emits the project it wrote, while the
    // background poll (openclaw/feature-entry.js) emits the project whose
    // counts moved. A watcher refreshes on the event, not on its payload.
    //
    // `ids` names the tasks that were added, removed or changed, so a board
    // can refresh one card instead of the column. It is a hint and may be
    // absent: an action emits the single id it wrote, the poll emits the diff
    // it computed, and a diff larger than MAX_CHANGED_IDS is emitted with no
    // `ids` at all — which means "refetch the list", not "nothing changed".
    'tasks-changed': object(
      {
        project: { type: 'string', maxLength: 64 },
        ids: { type: 'array', maxItems: MAX_CHANGED_IDS, items: { type: 'string', maxLength: 64 } },
      },
      [],
    ),
  },
});

export default contract;
