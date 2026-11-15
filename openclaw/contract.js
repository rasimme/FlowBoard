/**
 * FlowBoard feature contract (T-487-7, cut down in T-515-7).
 *
 * The native Control UI is the React dashboard; it reads and writes FlowBoard
 * through the Gateway API passthrough (ADR-0042), not through per-operation
 * contract calls. What remains here is the part that benefits from the host's
 * typed transport: the "needs me" query behind the dashboard widget, the
 * focus hint for the change poll, and the change events themselves. The host
 * validates every input and output against these schemas and enforces
 * `operator.read` on queries and `operator.write` on actions. See ADR-0040.
 *
 * Schemas are plain JSON Schema object literals rather than TypeBox builders.
 * The host normalizes JSON Schema for TypeBox before compiling a validator,
 * so a literal is validated identically while FlowBoard keeps a
 * dependency-free plugin root and a small browser bundle. Every string and
 * array is bounded; the Gateway rejects anything larger before a handler runs.
 */
import { defineFeatureContract } from 'openclaw/plugin-sdk/feature-contract';

/**
 * Why a task is on the operator's plate. `review` is FlowBoard's approve gate
 * (a human decides), `blocked` is the canonical work state (ADR-0031), and
 * `stuck` is the live stall detection behind `GET /api/tasks/stuck` — stale
 * checkpoints, expired leases, routed-but-unclaimed work, a due re-check, or
 * an explicit `waiting` state.
 */
export const NEEDS_ME_REASONS = ['review', 'blocked', 'stuck'];

export const MAX_PROJECTS = 200;
/** Hard ceiling on one "needing me" answer — a widget, not a board. */
export const MAX_NEEDS_ME = 100;
/** `tasks-changed.ids` is a hint; a bigger diff is sent without ids at all. */
export const MAX_CHANGED_IDS = 50;

const object = (properties, required = []) => ({
  type: 'object',
  additionalProperties: false,
  properties,
  ...(required.length ? { required } : {}),
});

const EMPTY_INPUT = object({});
const projectName = { type: 'string', minLength: 1, maxLength: 64 };
const nullableString = (maxLength) => ({
  anyOf: [{ type: 'string', minLength: 1, maxLength }, { type: 'null' }],
});

export const contract = defineFeatureContract({
  pluginId: 'flowboard',
  operations: {
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
    // `project` is optional: the background poll (openclaw/change-poll.js)
    // emits the project whose board or counts moved. A watcher refreshes on
    // the event, not on its payload.
    //
    // `ids` names the tasks that were added, removed or changed, so a board
    // can refresh one card instead of the column. It is a hint and may be
    // absent: the poll emits the diff it computed, and a diff larger than MAX_CHANGED_IDS is emitted with no
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
