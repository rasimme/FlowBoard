/**
 * FlowBoard feature contract (T-487-7, extended for stage 1 in T-487-8).
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
      description: 'List tasks of one FlowBoard project, optionally filtered by status.',
      input: object({ project: projectName, status: { type: 'string', enum: TASK_STATUSES } }, ['project']),
      output: object(
        {
          tasks: {
            type: 'array',
            maxItems: MAX_TASKS,
            items: object(
              {
                id: { type: 'string', maxLength: 64 },
                title: { type: 'string', maxLength: 256 },
                status: { type: 'string', maxLength: 32 },
                agent: nullableString(64),
                priority: { type: 'string', maxLength: 16 },
              },
              ['id', 'title', 'status', 'agent', 'priority'],
            ),
          },
        },
        ['tasks'],
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
  },
  events: {
    // Event ids may not contain dots (the SDK enforces /^[a-z][a-z0-9_-]{0,127}$/u
    // on events while operation ids allow them), so these use hyphens.
    'projects-changed': EMPTY_INPUT,
    // `project` is optional: an action emits the project it wrote, while the
    // background poll (openclaw/feature-entry.js) emits the project whose
    // counts moved. A watcher refreshes on the event, not on its payload.
    'tasks-changed': object({ project: { type: 'string', maxLength: 64 } }, []),
  },
});

export default contract;
