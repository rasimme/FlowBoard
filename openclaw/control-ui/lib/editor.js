/**
 * Panel edits as contract calls (T-499).
 *
 * The detail panel edits the title, the description, the priority and the
 * tags through `task.update`, and adds comments through `task.comment`. Each
 * edit is decided here, as data, before anything is sent:
 *
 *  - **An unchanged value sends nothing.** Saving a title that was not touched
 *    is a no-op, not a write that bumps timestamps and wakes every watcher.
 *  - **A truncated description is never written back.** `task.get` bounds the
 *    description; when the server says it cut one short, the panel only holds
 *    the head of it, and saving that would silently delete the tail. The
 *    editor refuses and points to the dashboard instead.
 *  - **The description is plain text and lossless.** Line endings are
 *    normalised the way the panel reads them, and nothing else is trimmed:
 *    trailing blank lines and indentation are the author's.
 *  - **Bounds match the contract** (`task.update` title 1..200, description
 *    ≤16384, tags ≤20 × ≤40; `task.comment` message 1..2000), so a refusal
 *    reads as a sentence next to the field rather than a schema error.
 *
 * Every function returns `{ noop: true }`, `{ error }`, or
 * `{ operation, input }` — the caller has exactly one place to branch.
 */

/*
 * The same readers as panel.js `descriptionText` / `descriptionTruncated`,
 * repeated rather than imported: the lib modules stay import-free so they
 * load in the unit tests without a bundler (test-plugin-entry-compat). The
 * unit tests pin both copies to the same answers.
 */
function descriptionText(detail) {
  const text = detail?.task?.description ?? detail?.description;
  return typeof text === 'string' ? text.replace(/\r\n?/gu, '\n') : '';
}

function descriptionTruncated(detail) {
  return Boolean(detail?.task?.descriptionTruncated ?? detail?.descriptionTruncated);
}

export const MAX_TITLE = 200;
export const MAX_DESCRIPTION = 16384;
export const MAX_TAGS = 20;
export const MAX_TAG_LENGTH = 40;
export const MAX_COMMENT = 2000;
export const PRIORITIES = ['low', 'medium', 'high'];

function normalizeLines(value) {
  return typeof value === 'string' ? value.replace(/\r\n?/gu, '\n') : '';
}

function update(project, id, patch) {
  return { operation: 'task.update', input: { project, id, ...patch } };
}

function target(project, task) {
  return project && task?.id ? { project, id: task.id } : null;
}

export function titleEdit({ project, task, value } = {}) {
  const at = target(project, task);
  if (!at) return { error: 'Nothing to edit.' };
  const text = typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim() : '';
  if (!text) return { error: 'A title is required.' };
  if (text.length > MAX_TITLE) return { error: `Keep the title under ${MAX_TITLE} characters.` };
  if (text === task.title) return { noop: true };
  return update(at.project, at.id, { title: text });
}

/** `detail` is the `task.get` answer the panel is showing. */
export function descriptionEdit({ project, detail, value } = {}) {
  const task = detail?.task;
  const at = target(project, task);
  if (!at) return { error: 'Nothing to edit.' };
  if (descriptionTruncated(detail)) {
    return { error: 'This description is longer than the panel can hold — edit it in FlowBoard so nothing is lost.' };
  }
  const text = normalizeLines(value);
  if (text.length > MAX_DESCRIPTION) {
    return { error: `Keep the description under ${MAX_DESCRIPTION} characters.` };
  }
  if (text === descriptionText(detail)) return { noop: true };
  return update(at.project, at.id, { description: text });
}

/** Whether the panel may open the description editor at all. */
export function canEditDescription(detail) {
  return Boolean(detail?.task) && !descriptionTruncated(detail);
}

export function priorityEdit({ project, task, value } = {}) {
  const at = target(project, task);
  if (!at) return { error: 'Nothing to edit.' };
  if (!PRIORITIES.includes(value)) return { error: 'That is not a priority FlowBoard knows.' };
  if (value === (task.priority || 'medium')) return { noop: true };
  return update(at.project, at.id, { priority: value });
}

/** Comma-separated text → a clean tag list (no '#', no blanks, no repeats). */
export function parseTags(value) {
  if (typeof value !== 'string') return [];
  const seen = new Set();
  const tags = [];
  for (const part of value.split(',')) {
    const tag = part.trim().replace(/^#+/u, '').trim();
    if (!tag || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
}

/** The tag list as the editor shows it. */
export function formatTags(tags) {
  return Array.isArray(tags) ? tags.filter((tag) => typeof tag === 'string' && tag).join(', ') : '';
}

export function tagsEdit({ project, task, value } = {}) {
  const at = target(project, task);
  if (!at) return { error: 'Nothing to edit.' };
  const tags = parseTags(value);
  if (tags.length > MAX_TAGS) return { error: `Use at most ${MAX_TAGS} tags.` };
  const long = tags.find((tag) => tag.length > MAX_TAG_LENGTH);
  if (long) return { error: `Keep each tag under ${MAX_TAG_LENGTH} characters.` };
  const current = Array.isArray(task.tags) ? task.tags : [];
  if (tags.length === current.length && tags.every((tag, at2) => tag === current[at2])) return { noop: true };
  return update(at.project, at.id, { tags });
}

/** Characters left in the comment box (negative when over). */
export function commentRemaining(value) {
  return MAX_COMMENT - (typeof value === 'string' ? value.trim().length : 0);
}

export function commentRequest({ project, task, value } = {}) {
  const at = target(project, task);
  if (!at) return { error: 'Nothing to comment on.' };
  const text = typeof value === 'string' ? normalizeLines(value).trim() : '';
  if (!text) return { noop: true };
  if (text.length > MAX_COMMENT) return { error: `Keep the comment under ${MAX_COMMENT} characters.` };
  return { operation: 'task.comment', input: { project: at.project, id: at.id, message: text } };
}

/**
 * "New task" from the board. Only the title is asked for; everything else is
 * edited in the panel that opens on the created task. `task.create` bounds
 * the title at 128.
 */
export const MAX_CREATE_TITLE = 128;

export function createRequest({ project, title } = {}) {
  if (!project) return { error: 'Pick a project first.' };
  const text = typeof title === 'string' ? title.replace(/\s+/gu, ' ').trim() : '';
  if (!text) return { error: 'A title is required.' };
  if (text.length > MAX_CREATE_TITLE) return { error: `Keep the title under ${MAX_CREATE_TITLE} characters.` };
  return { operation: 'task.create', input: { project, title: text } };
}

/** The code FlowBoard answers a create with on a project that enforces Specify. */
export const SPECIFY_REQUIRED = 'SPECIFY_REQUIRED';
