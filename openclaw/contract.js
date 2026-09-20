/**
 * FlowBoard feature contract (T-487-7).
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

export const MAX_PROJECTS = 200;
export const MAX_TASKS = 500;

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
      description: 'List FlowBoard projects with their lifecycle status.',
      input: EMPTY_INPUT,
      output: object(
        {
          projects: {
            type: 'array',
            maxItems: MAX_PROJECTS,
            items: object(
              { name: { type: 'string', maxLength: 64 }, status: { type: 'string', maxLength: 32 } },
              ['name', 'status'],
            ),
          },
        },
        ['projects'],
      ),
    },
    'status.get': {
      kind: 'query',
      description: 'Read the FlowBoard project an agent is currently bound to.',
      input: object({ agentId, sessionKey }, ['agentId']),
      output: object(
        {
          activeProject: nullableString(64),
          binding: object(
            {
              agentId: { type: 'string', maxLength: 64 },
              contextReady: { type: 'boolean' },
              sessionKey: nullableString(256),
            },
            ['agentId', 'contextReady', 'sessionKey'],
          ),
        },
        ['activeProject', 'binding'],
      ),
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
    'status.set': {
      kind: 'action',
      description: 'Bind an agent to a FlowBoard project, or clear its binding with project: null.',
      input: object({ agentId, project: { anyOf: [projectName, { type: 'null' }] }, sessionKey }, [
        'agentId',
        'project',
      ]),
      output: object({ activeProject: nullableString(64) }, ['activeProject']),
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
    'tasks-changed': object({ project: { type: 'string', maxLength: 64 } }, ['project']),
  },
});

export default contract;
