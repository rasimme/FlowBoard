/**
 * FlowBoard native Control UI page — stage 2 (T-498).
 *
 * The board is now FlowBoard's own, inside the Gateway. Stage 1 put a rail
 * above a framed dashboard; stage 2 replaces the board itself with native
 * views built on the feature contract (openclaw/contract.js), so the host
 * validates every payload and enforces `operator.read` on reads and
 * `operator.write` on writes before a FlowBoard handler runs, and every write
 * is attributed to the signed-in operator (ADR-0040).
 *
 * The page is three things stacked:
 *
 *  - **The rail** (stage 1, unchanged in substance) — projects with what is
 *    waiting in them, the tasks needing the operator, and a status line.
 *  - **A tab strip** — *Board* (native), *Ideas* and *Files* (still the framed
 *    SPA, until stage 3), plus a link that opens the full dashboard.
 *  - **The board** — five columns, cards, a per-card action menu, and a detail
 *    panel. Moves, work-state changes and the approve gate are contract
 *    actions; nothing here talks to FlowBoard's HTTP API directly.
 *
 * Two rules decide how writes behave, and both are the opposite of the SPA's
 * optimistic rendering (docs/concepts/kanban.md, "Consequences"):
 *
 *  1. **The server's answer is the only thing drawn.** An action shows a
 *     transient saving state, then renders the task the action returned, and
 *     the `tasks-changed` watch reconciles behind it. Nothing moves on a card
 *     before the write succeeded, so a failed write cannot leave a card
 *     sitting in a column it never reached.
 *  2. **A failure is shown where it happened, never swallowed.** The backend's
 *     own message lands on the card and in the panel.
 *
 * The iframe is mounted once and hidden — not unmounted — while the board is
 * up, so switching tabs never reloads the SPA. All ids and classes are `fb-` /
 * `flowboard-` namespaced, and the styling inherits the host's theme tokens
 * rather than shipping a palette (see index.css).
 */
import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';

import { contract } from '../contract.js';
import {
  actionReducer,
  actionRequest,
  dropRequest,
  errorFor,
  initialActionState,
  isSaving,
  menuModel,
} from './lib/actions.js';
import {
  BOARD_COLUMNS,
  groupTasksByStatus,
  leaseState,
  relationLabel,
  showsWorkState,
  statusLabel,
  stuckLabel,
  workStateDetail,
  workStateLabel,
} from './lib/board.js';
import { buildFrameUrl, buildPageParams, readPageParams } from './lib/deep-link.js';
import { countNeedsMe, describeNeedsMe, groupNeedsMe, reasonLabel } from './lib/needs-me.js';
import {
  descriptionText,
  descriptionTruncated,
  initialPanelState,
  panelReducer,
  panelTask,
  specFile,
  visibleCheckpoints,
  visibleComments,
} from './lib/panel.js';
import {
  DEFAULT_AGENT_ID,
  readAgentId,
  readRailCollapsed,
  writeAgentId,
  writeRailCollapsed,
} from './lib/settings.js';
import { initialWatchState, watchReducer } from './lib/watch-state.js';
import { TABS, focusProject, initialViewState, isFramedTab, selectionOf, showsBoard, viewReducer } from './lib/view-state.js';
import './index.css';

const PAGE_ID = 'flowboard';
const NEEDS_ME_LIMIT = 40;
/** A board, not an export: enough for any real project, bounded for the wire. */
const BOARD_TASK_LIMIT = 200;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(className, text, label) {
  const node = element('button', className, text);
  node.type = 'button';
  if (label) node.setAttribute('aria-label', label);
  return node;
}

function storage() {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    // Blocked site data throws on property access, not only on use.
    return null;
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error ?? 'unknown error');
}

function clockTime(at) {
  if (!at) return 'never';
  try {
    return new Date(at).toLocaleTimeString();
  } catch {
    return 'unknown';
  }
}

function dateText(value) {
  if (!value) return '';
  try {
    return new Date(value).toLocaleString();
  } catch {
    return String(value);
  }
}

/**
 * Bind this connection's Gateway-verified operator profile.
 *
 * Hoisted out of the page mount (T-487-7 follow-up): any view may write, and a
 * write that runs before the capture is attributed to the anonymous local
 * operator instead of the signed-in human (ADR-0040). The capture is per
 * connection, so it is redone after a reconnect and never cached across one.
 */
function createIdentityBinder(host) {
  let pending = null;
  const ensure = () => {
    if (!pending) {
      pending = Promise.resolve()
        .then(() => host.request('flowboard.ui.identity', {}))
        .catch(() => null);
    }
    return pending;
  };
  const unsubscribe = host.subscribe?.(() => {
    if (!host.connection?.connected) pending = null;
    else void ensure();
  });
  return { ensure, dispose: () => unsubscribe?.() };
}

/* ------------------------------------------------------------------ views */

/** Project switcher: the list, the active marker, and the write. */
function createProjectSwitcher({ onSelect }) {
  const section = element('section', 'fb-rail__section');
  section.id = 'flowboard-projects';
  const heading = element('h2', 'fb-rail__heading', 'Projects');
  const body = element('div', 'fb-chips');
  body.setAttribute('role', 'list');
  section.append(heading, body);

  let signature = '';
  let pending = null;
  let viewing = null;

  function renderRows(projects, activeProject) {
    for (const project of projects) {
      const row = element('button', 'fb-chip');
      row.type = 'button';
      row.setAttribute('role', 'listitem');
      row.dataset.fbProject = project.name;
      row.dataset.fbStatus = project.status || 'unknown';
      const active = project.name === activeProject;
      if (active) {
        row.dataset.fbActive = 'true';
        row.setAttribute('aria-current', 'true');
      }
      // The board below follows the selection, which is not always the agent's
      // active project — a separate marker so the two are never confused.
      if (project.name === viewing) row.dataset.fbViewing = 'true';
      row.append(element('span', 'fb-chip__name', project.name));
      const needs = (project.counts?.review || 0) + (project.counts?.blocked || 0);
      if (needs > 0) {
        const badge = element('span', 'fb-chip__badge', String(needs));
        badge.title = `${project.counts.review} in review, ${project.counts.blocked} blocked`;
        row.append(badge);
      }
      row.title = active
        ? `${project.name} — active for this agent; opens its board`
        : `Switch this agent to ${project.name} and open its board`;
      row.disabled = Boolean(pending);
      row.onclick = () => {
        if (pending) return;
        pending = project.name;
        body.dataset.fbPending = project.name;
        onSelect(project.name).finally(() => {
          pending = null;
          delete body.dataset.fbPending;
          signature = '';
        });
      };
      body.append(row);
    }
  }

  return {
    section,
    setViewing(project) {
      if (project === viewing) return;
      viewing = project;
      signature = '';
    },
    render(state, activeProject) {
      const projects = state.data?.projects ?? [];
      const next = `${state.phase}|${activeProject ?? ''}|${viewing ?? ''}|${projects
        .map((project) => `${project.name}:${project.status}:${project.counts?.review}:${project.counts?.blocked}`)
        .join(',')}`;
      if (next === signature) return;
      signature = next;
      body.replaceChildren();
      if (state.phase === 'loading') {
        body.append(element('p', 'fb-hint', 'Loading projects…'));
        return;
      }
      if (state.phase === 'error') {
        body.append(element('p', 'fb-hint fb-hint--error', `Projects unavailable: ${state.error}`));
        return;
      }
      if (!projects.length) {
        body.append(element('p', 'fb-hint', 'No projects yet. Create one in the FlowBoard dashboard.'));
        return;
      }
      renderRows(projects, activeProject);
    },
  };
}

/** Tasks needing me: the approve gate and the stalled work, grouped. */
function createNeedsMe({ onOpen }) {
  const section = element('section', 'fb-rail__section');
  section.id = 'flowboard-needs-me';
  const heading = element('h2', 'fb-rail__heading', 'Tasks needing me');
  const badge = element('span', 'fb-rail__count');
  heading.append(badge);
  const body = element('div', 'fb-needs');
  section.append(heading, body);

  let signature = '';
  let selectedId = '';

  function renderRow(item) {
    const row = element('button', 'fb-needs__row');
    row.type = 'button';
    row.dataset.fbTask = `${item.project}/${item.id}`;
    row.dataset.fbReason = item.reason;
    if (`${item.project}/${item.id}` === selectedId) row.dataset.fbSelected = 'true';
    row.append(element('span', 'fb-needs__id', item.id));
    row.append(element('span', 'fb-needs__title', item.title || '(untitled)'));
    row.append(element('span', 'fb-needs__reason', reasonLabel(item)));
    const detail = describeNeedsMe(item);
    row.append(element('span', 'fb-needs__meta', detail ? `${item.project} · ${detail}` : item.project));
    row.title = `${item.project} · ${item.id} — open on the board`;
    row.onclick = () => {
      selectedId = `${item.project}/${item.id}`;
      signature = '';
      onOpen(item);
    };
    return row;
  }

  return {
    section,
    setSelected(project, task) {
      const next = project && task ? `${project}/${task}` : '';
      if (next === selectedId) return;
      selectedId = next;
      signature = '';
    },
    render(state) {
      const items = state.data?.items ?? [];
      const next = `${state.phase}|${selectedId}|${state.data?.truncated ? 't' : 'f'}|${items
        .map((item) => `${item.project}/${item.id}:${item.reason}:${item.note ?? ''}`)
        .join(',')}`;
      if (next === signature) return;
      signature = next;
      body.replaceChildren();
      badge.textContent = state.data ? String(countNeedsMe(items)) : '';
      if (state.phase === 'loading') {
        body.append(element('p', 'fb-hint', 'Loading…'));
        return;
      }
      if (state.phase === 'error') {
        body.append(element('p', 'fb-hint fb-hint--error', `Unavailable: ${state.error}`));
        return;
      }
      if (!items.length) {
        body.append(element('p', 'fb-hint', 'Nothing waiting on you. Agents will surface review and blocked work here.'));
        return;
      }
      for (const group of groupNeedsMe(items)) {
        if (!group.items.length) continue;
        const wrapper = element('div', 'fb-needs__group');
        wrapper.dataset.fbGroup = group.id;
        wrapper.append(element('h3', 'fb-needs__group-label', `${group.label} (${group.items.length})`));
        const list = element('div', 'fb-needs__rows');
        for (const item of group.items) list.append(renderRow(item));
        wrapper.append(list);
        body.append(wrapper);
      }
      if (state.data?.truncated) {
        body.append(element('p', 'fb-hint', `Showing the first ${items.length}. Open the board for the rest.`));
      }
    },
  };
}

/**
 * The card action menu — one element for the whole page, moved to whichever
 * button opened it.
 *
 * It is the primary way to act on a task (drag and drop is the pointer
 * shortcut), so it is a real `role="menu"`: arrow keys walk it, Escape closes
 * it and gives focus back to the button that opened it, and an item that needs
 * prose swaps the list for a small form instead of opening a second layer.
 */
function createMenuLayer({ onSubmit }) {
  const root = element('div', 'fb-menu');
  root.id = 'flowboard-menu';
  root.hidden = true;
  root.setAttribute('role', 'menu');
  root.tabIndex = -1;

  let anchor = null;
  let current = null;
  let formOpen = false;

  function close({ restoreFocus = true } = {}) {
    if (root.hidden) return;
    root.hidden = true;
    formOpen = false;
    root.replaceChildren();
    const previous = anchor;
    anchor?.setAttribute('aria-expanded', 'false');
    anchor = null;
    current = null;
    if (restoreFocus && previous?.isConnected) previous.focus();
  }

  function itemsInMenu() {
    return [...root.querySelectorAll('[role="menuitem"]:not(:disabled)')];
  }

  function moveFocus(delta) {
    const items = itemsInMenu();
    if (!items.length) return;
    const index = items.indexOf(document.activeElement);
    const next = index < 0 ? 0 : (index + delta + items.length) % items.length;
    items[next].focus();
  }

  root.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') {
      event.stopPropagation();
      event.preventDefault();
      close();
      return;
    }
    if (event.key === 'Tab') {
      close({ restoreFocus: false });
      return;
    }
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      moveFocus(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      moveFocus(-1);
    }
  });

  /** A small form for the one item that needs words before it can run. */
  function renderForm(item) {
    root.replaceChildren();
    formOpen = true;
    const form = element('form', 'fb-menu__form');
    const label = element('label', 'fb-menu__label', item.kind === 'reject' ? 'Why is this rejected?' : 'Reason (optional)');
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'fb-menu__input';
    input.maxLength = 500;
    input.autocomplete = 'off';
    input.id = 'flowboard-menu-reason';
    label.htmlFor = input.id;
    const error = element('p', 'fb-menu__error');
    error.setAttribute('role', 'alert');
    const actions = element('div', 'fb-menu__actions');
    const submit = element('button', 'fb-menu__submit', item.kind === 'reject' ? 'Reject' : `Set ${item.label.toLowerCase()}`);
    submit.type = 'submit';
    const cancel = button('fb-menu__cancel', 'Cancel');
    cancel.onclick = () => close();
    actions.append(submit, cancel);
    form.append(label, input, error, actions);
    form.onsubmit = (event) => {
      event.preventDefault();
      // Validate, then close, then run: the action redraws the board, and a
      // redraw while this menu is open would destroy the button that focus is
      // owed back to.
      const outcome = onSubmit({ ...current, item, reason: input.value });
      if (outcome?.error) {
        error.textContent = outcome.error;
        input.focus();
        return;
      }
      close({ restoreFocus: true });
      outcome.run?.();
    };
    root.append(form);
    input.focus();
  }

  function renderItems(task) {
    root.replaceChildren();
    formOpen = false;
    for (const group of menuModel(task)) {
      const section = element('div', 'fb-menu__group');
      section.setAttribute('role', 'group');
      section.setAttribute('aria-label', group.label);
      section.append(element('p', 'fb-menu__group-label', group.label));
      for (const item of group.items) {
        const entry = button('fb-menu__item', item.label);
        entry.setAttribute('role', 'menuitem');
        entry.dataset.fbAction = item.id;
        if (item.kind === 'work-state') {
          entry.setAttribute('role', 'menuitemradio');
          entry.setAttribute('aria-checked', item.current ? 'true' : 'false');
          entry.disabled = item.current;
        }
        if (item.kind === 'reject') entry.dataset.fbDanger = 'true';
        entry.onclick = () => {
          // Anything that may carry prose opens the form; approve is the one
          // optional reason that is not worth a second step.
          if (item.reason === 'required' || (item.reason === 'optional' && item.kind !== 'approve')) {
            renderForm(item);
            return;
          }
          const outcome = onSubmit({ ...current, item, reason: '' });
          if (outcome?.error) {
            renderForm(item);
            return;
          }
          close({ restoreFocus: true });
          outcome.run?.();
        };
        section.append(entry);
      }
      root.append(section);
    }
  }

  return {
    element: root,
    close,
    isOpen: () => !root.hidden,
    /**
     * Follow the card through a board redraw.
     *
     * The board replaces its cards wholesale, so the button this menu hangs
     * off is destroyed by any refresh — including the one FlowBoard sends a
     * few seconds after someone else's write. Closing the menu then would
     * throw away a reject reason mid-sentence, so instead the menu re-anchors
     * to the new button and only closes when the card is really gone. A menu
     * that is merely listing actions is rebuilt from the fresh task (its
     * status may have moved); one with a form open is left exactly as typed.
     */
    retarget(resolve) {
      if (root.hidden || !current?.task) return;
      const next = resolve(current.task.id);
      if (!next?.anchor || !next.task) {
        close({ restoreFocus: false });
        return;
      }
      if (anchor !== next.anchor) {
        anchor?.setAttribute('aria-expanded', 'false');
        anchor = next.anchor;
        anchor.setAttribute('aria-expanded', 'true');
      }
      current = { ...current, task: next.task };
      if (!formOpen) renderItems(next.task);
    },
    open({ anchor: target, project, task, bounds }) {
      if (anchor === target && !root.hidden) {
        close();
        return;
      }
      close({ restoreFocus: false });
      anchor = target;
      current = { project, task };
      root.hidden = false;
      root.setAttribute('aria-label', `Actions for ${task.id}`);
      anchor?.setAttribute('aria-expanded', 'true');
      renderItems(task);
      // Positioned against the page box so the menu is never clipped by a
      // scrolling column, and clamped so it cannot leave the page.
      const anchorRect = target.getBoundingClientRect();
      const pageRect = bounds.getBoundingClientRect();
      const top = anchorRect.bottom - pageRect.top + bounds.scrollTop + 4;
      const left = Math.max(
        4,
        Math.min(anchorRect.left - pageRect.left, bounds.clientWidth - root.offsetWidth - 8),
      );
      root.style.top = `${Math.round(top)}px`;
      root.style.left = `${Math.round(left)}px`;
      itemsInMenu()[0]?.focus();
    },
  };
}

/** The native Kanban board: five columns of cards. */
function createBoard({ onOpenTask, onMenu, onMove, onRedrawn, onFilter }) {
  const root = element('div', 'fb-board');
  root.id = 'flowboard-board';

  // `tasks.list` is bounded, so a large project comes back truncated. Asking
  // for one status is the only narrowing the contract offers, which makes it
  // the only honest thing to offer next to that notice.
  const bar = element('div', 'fb-board__bar');
  const filterLabel = element('label', 'fb-board__filter');
  filterLabel.htmlFor = 'flowboard-board-filter';
  filterLabel.append(element('span', 'fb-board__filter-label', 'Column'));
  const filterSelect = document.createElement('select');
  filterSelect.id = 'flowboard-board-filter';
  filterSelect.className = 'fb-board__select';
  for (const option of [{ id: '', label: 'All columns' }, ...BOARD_COLUMNS]) {
    const node = element('option', '', option.label);
    node.value = option.id;
    filterSelect.append(node);
  }
  filterSelect.title = 'Load the whole project, or only one column of it';
  filterSelect.onchange = () => onFilter(filterSelect.value);
  filterLabel.append(filterSelect);

  const notice = element('p', 'fb-board__notice');
  notice.setAttribute('role', 'status');
  bar.append(filterLabel, notice);
  const columns = element('div', 'fb-board__columns');
  root.append(bar, columns);

  const bodies = new Map();
  for (const column of BOARD_COLUMNS) {
    const section = element('section', 'fb-col');
    section.dataset.fbColumn = column.id;
    section.setAttribute('role', 'group');
    const head = element('div', 'fb-col__head');
    head.append(element('h3', 'fb-col__label', column.label));
    const count = element('span', 'fb-col__count', '0');
    head.append(count);
    const body = element('div', 'fb-col__cards');
    body.setAttribute('role', 'list');
    section.append(head, body);
    // Dropping is a pointer convenience over the same move the menu makes.
    section.addEventListener('dragover', (event) => {
      if (!event.dataTransfer?.types?.includes('text/plain')) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'move';
      section.dataset.fbDropping = 'true';
    });
    section.addEventListener('dragleave', (event) => {
      if (event.target === section) delete section.dataset.fbDropping;
    });
    section.addEventListener('drop', (event) => {
      event.preventDefault();
      delete section.dataset.fbDropping;
      const id = event.dataTransfer?.getData('text/plain');
      if (id) onMove(id, column.id);
    });
    bodies.set(column.id, { section, body, count });
    columns.append(section);
  }

  function chip(className, text, title) {
    const node = element('span', `fb-chipline__item ${className}`, text);
    if (title) node.title = title;
    return node;
  }

  function renderCard(task, { project, actions, selected, now }) {
    const card = element('article', 'fb-card');
    const isOpen = selected === task.id;
    card.dataset.fbTask = task.id;
    card.dataset.fbPriority = task.priority || 'medium';
    card.draggable = true;
    card.setAttribute('role', 'listitem');
    if (isOpen) card.dataset.fbSelected = 'true';
    if (isSaving(actions, task.id)) card.dataset.fbSaving = 'true';

    const open = button('fb-card__open');
    open.dataset.fbFocusKey = `${task.id}:open`;
    open.append(element('span', 'fb-card__id', task.id));
    open.append(element('span', 'fb-card__title', task.title || '(untitled)'));
    open.title = `Open ${task.id}`;
    open.setAttribute('aria-expanded', isOpen ? 'true' : 'false');
    open.onclick = () => onOpenTask(task);

    const menuButton = button('fb-card__menu', '⋯', `Actions for ${task.id}`);
    menuButton.dataset.fbFocusKey = `${task.id}:menu`;
    menuButton.setAttribute('aria-haspopup', 'menu');
    menuButton.setAttribute('aria-expanded', 'false');
    menuButton.setAttribute('aria-controls', 'flowboard-menu');
    menuButton.onclick = () => onMenu(menuButton, task);

    const head = element('div', 'fb-card__head');
    head.append(open, menuButton);
    card.append(head);

    const line = element('div', 'fb-chipline');
    line.append(chip('fb-chipline__priority', task.priority || 'medium', 'Priority'));
    if (task.agent) line.append(chip('fb-chipline__agent', `@${task.agent}`, 'Claimed by'));
    if (showsWorkState(task)) {
      const detail = workStateDetail(task);
      line.append(
        chip(
          'fb-chipline__state',
          workStateLabel(task.workState),
          detail ? `${workStateLabel(task.workState)}: ${detail}` : 'Work state',
        ),
      );
      card.dataset.fbWorkState = task.workState;
    }
    const relation = relationLabel(task);
    if (relation) line.append(chip('fb-chipline__relation', relation, 'Subtasks'));
    if (task.specExists) line.append(chip('fb-chipline__spec', '● spec', 'A spec file is linked'));
    const lease = leaseState(task, now);
    if (lease.state === 'stale') {
      line.append(chip('fb-chipline__lease', lease.label, 'The claim expired; anyone may reclaim this task'));
      card.dataset.fbStale = 'true';
    }
    const stuck = stuckLabel(task);
    if (stuck) line.append(chip('fb-chipline__stuck', stuck, 'Stall detection'));
    if (Array.isArray(task.tags)) {
      for (const tag of task.tags.slice(0, 3)) line.append(chip('fb-chipline__tag', `#${tag}`, 'Tag'));
    }
    card.append(line);

    const failure = errorFor(actions, task.id);
    if (failure) {
      const message = element('p', 'fb-card__error', failure);
      message.setAttribute('role', 'alert');
      card.append(message);
    } else if (isSaving(actions, task.id)) {
      card.append(element('p', 'fb-card__saving', 'Saving…'));
    }

    card.addEventListener('dragstart', (event) => {
      event.dataTransfer?.setData('text/plain', task.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
      card.dataset.fbDragging = 'true';
    });
    card.addEventListener('dragend', () => delete card.dataset.fbDragging);
    // `project` is carried for the title only; the action itself reads it from
    // the page state, so a stale card can never write into another project.
    card.title = `${project} · ${task.id} · ${statusLabel(task.status)}`;
    return card;
  }

  let signature = '';

  return {
    element: root,
    invalidate() {
      signature = '';
    },
    render(state, { project, actions, selected, now, filter }) {
      const tasks = state.data?.tasks ?? [];
      const next = [
        state.phase,
        project ?? '',
        filter ?? '',
        selected ?? '',
        actions.pending ?? '',
        actions.errorId ?? '',
        actions.error ?? '',
        state.data?.truncated ? 't' : 'f',
        tasks
          .map(
            (task) =>
              `${task.id}:${task.status}:${task.workState}:${task.priority}:${task.agent ?? ''}:${task.order ?? ''}` +
              `:${task.title}:${task.subtaskCount ?? 0}:${task.parentId ?? ''}:${task.specExists ? 1 : 0}` +
              `:${task.leaseUntil ?? ''}:${(task.tags || []).join('+')}:${task.stuckIndicator ? 1 : 0}` +
              `:${JSON.stringify(task.workStateDetails ?? null)}`,
          )
          .join(','),
      ].join('|');
      if (next === signature) return;
      signature = next;

      // A full redraw is cheap and keeps the columns honest; the focused
      // control is restored afterwards so a background refresh never steals
      // the keyboard out from under an operator.
      const active = document.activeElement;
      const focusKey = active && root.contains(active) ? active.dataset?.fbFocusKey ?? null : null;

      notice.textContent = '';
      delete notice.dataset.fbKind;
      if (!project) {
        notice.textContent = 'Pick a project in the rail to open its board.';
      } else if (state.phase === 'loading') {
        notice.textContent = 'Loading the board…';
      } else if (state.phase === 'error') {
        notice.textContent = `The board is unavailable: ${state.error}`;
        notice.dataset.fbKind = 'error';
      } else if (state.phase === 'stale') {
        notice.textContent = `Showing the last board that loaded — refreshing failed: ${state.error}`;
        notice.dataset.fbKind = 'error';
      } else if (state.data?.truncated) {
        notice.textContent = filter
          ? `Showing the first ${tasks.length} tasks of this column. Open FlowBoard for the rest.`
          : `Showing the first ${tasks.length} tasks. Pick one column above to load more of it, or open FlowBoard.`;
      }
      if (filterSelect.value !== (filter || '')) filterSelect.value = filter || '';

      const groups = groupTasksByStatus(tasks);
      for (const group of groups) {
        const target = bodies.get(group.id);
        target.count.textContent = String(group.count);
        target.section.setAttribute('aria-label', `${group.label}, ${group.count} task${group.count === 1 ? '' : 's'}`);
        target.body.replaceChildren();
        if (!group.count) {
          // A column the filter did not ask for is empty because nothing was
          // fetched for it, which is not the same as "nothing is here".
          const hidden = Boolean(filter) && filter !== group.id;
          if (hidden) target.count.textContent = '—';
          target.body.append(
            element(
              'p',
              'fb-col__empty',
              hidden ? 'Not loaded — showing one column' : project && state.phase !== 'loading' ? 'Nothing here' : '',
            ),
          );
          continue;
        }
        for (const task of group.tasks) {
          target.body.append(renderCard(task, { project, actions, selected, now }));
        }
      }

      if (focusKey) {
        const restored = root.querySelector(`[data-fb-focus-key="${CSS.escape(focusKey)}"]`);
        restored?.focus?.();
      }

      // Every card node was just replaced, so anything anchored to one of
      // them has to be pointed at its successor (or told the card is gone).
      onRedrawn?.((taskId) => ({
        anchor: root.querySelector(`[data-fb-focus-key="${CSS.escape(`${taskId}:menu`)}"]`),
        task: tasks.find((entry) => entry.id === taskId) ?? null,
      }));
    },
  };
}

/** The task detail panel: what `task.get` knows, and the same actions. */
function createPanel({ onClose, onMenu }) {
  const root = element('aside', 'fb-panel');
  root.id = 'flowboard-panel';
  root.hidden = true;
  root.setAttribute('role', 'complementary');
  root.setAttribute('aria-label', 'Task details');

  const head = element('div', 'fb-panel__head');
  const heading = element('h2', 'fb-panel__title');
  heading.id = 'flowboard-panel-title';
  heading.tabIndex = -1;
  const menuButton = button('fb-panel__menu', 'Actions', 'Task actions');
  menuButton.setAttribute('aria-haspopup', 'menu');
  menuButton.setAttribute('aria-expanded', 'false');
  menuButton.setAttribute('aria-controls', 'flowboard-menu');
  const close = button('fb-panel__close', '✕', 'Close the task details');
  head.append(heading, menuButton, close);
  close.onclick = () => onClose();
  root.setAttribute('aria-labelledby', heading.id);

  const body = element('div', 'fb-panel__body');
  root.append(head, body);

  let signature = '';

  function meta(label, value) {
    const row = element('div', 'fb-meta__row');
    row.append(element('dt', 'fb-meta__key', label));
    row.append(element('dd', 'fb-meta__value', value));
    return row;
  }

  return {
    element: root,
    heading,
    invalidate() {
      signature = '';
    },
    render(state, { dashboardUrl, actions }) {
      const next = [
        state.open ? '1' : '0',
        state.project ?? '',
        state.id ?? '',
        state.phase,
        state.error ?? '',
        state.updatedAt ?? '',
        actions.pending ?? '',
        actions.errorId ?? '',
        actions.error ?? '',
        panelTask(state)?.status ?? '',
        panelTask(state)?.workState ?? '',
      ].join('|');
      if (next === signature) return;
      signature = next;

      root.hidden = !state.open;
      if (!state.open) {
        body.replaceChildren();
        heading.textContent = '';
        return;
      }

      const task = panelTask(state);
      heading.textContent = task ? `${task.id} · ${task.title}` : state.id;
      menuButton.hidden = !task;

      body.replaceChildren();
      if (state.phase === 'loading' && !task) {
        body.append(element('p', 'fb-hint', 'Loading the task…'));
        return;
      }
      if (state.phase === 'error' && !task) {
        const message = element('p', 'fb-hint fb-hint--error', `Could not load ${state.id}: ${state.error}`);
        message.setAttribute('role', 'alert');
        body.append(message);
        return;
      }
      if (!task) return;

      if (state.phase === 'stale') {
        const message = element('p', 'fb-hint fb-hint--error', `Refreshing failed: ${state.error}`);
        message.setAttribute('role', 'status');
        body.append(message);
      }

      const failure = errorFor(actions, task.id);
      if (failure) {
        const message = element('p', 'fb-panel__error', failure);
        message.setAttribute('role', 'alert');
        body.append(message);
      } else if (isSaving(actions, task.id)) {
        body.append(element('p', 'fb-panel__saving', 'Saving…'));
      }

      const list = element('dl', 'fb-meta');
      list.append(meta('Status', statusLabel(task.status)));
      list.append(
        meta(
          'Work state',
          workStateDetail(task)
            ? `${workStateLabel(task.workState)} — ${workStateDetail(task)}`
            : workStateLabel(task.workState),
        ),
      );
      list.append(meta('Priority', task.priority || 'medium'));
      list.append(meta('Agent', task.agent ? `@${task.agent}` : 'unclaimed'));
      if (task.parentId) list.append(meta('Parent', task.parentId));
      if (task.subtaskCount) list.append(meta('Subtasks', String(task.subtaskCount)));
      if (Array.isArray(task.tags) && task.tags.length) list.append(meta('Tags', task.tags.map((tag) => `#${tag}`).join(' ')));
      if (task.created) list.append(meta('Created', dateText(task.created)));
      if (task.enteredStatusAt) list.append(meta(`In ${statusLabel(task.status)} since`, dateText(task.enteredStatusAt)));
      const lease = leaseState(task);
      if (lease.state !== 'none') list.append(meta('Claim', lease.label));
      if (specFile(state.data)) list.append(meta('Spec', specFile(state.data)));
      const stuck = stuckLabel(task);
      if (stuck) list.append(meta('Attention', stuck));
      body.append(list);

      const descriptionBody = descriptionText(state.data);
      const description = element('section', 'fb-panel__section');
      description.append(element('h3', 'fb-panel__heading', 'Description'));
      if (descriptionBody) {
        // Plain text, line breaks preserved by CSS. Never innerHTML: the
        // description is agent-written and this page holds Gateway authority.
        description.append(element('p', 'fb-panel__description', descriptionBody));
        if (descriptionTruncated(state.data)) {
          description.append(element('p', 'fb-hint', 'Shortened — open FlowBoard for the whole description.'));
        }
      } else {
        description.append(element('p', 'fb-hint', 'No description.'));
      }
      body.append(description);

      const comments = visibleComments(state.data);
      const commentSection = element('section', 'fb-panel__section');
      commentSection.append(element('h3', 'fb-panel__heading', `Comments (${comments.length})`));
      if (comments.length) {
        const rows = element('ul', 'fb-thread');
        for (const entry of comments) {
          const row = element('li', 'fb-thread__row');
          row.dataset.fbKind = entry.kind || 'comment';
          row.append(element('span', 'fb-thread__who', entry.author || 'unknown'));
          row.append(element('span', 'fb-thread__when', dateText(entry.timestamp)));
          row.append(element('p', 'fb-thread__text', entry.message || ''));
          rows.append(row);
        }
        commentSection.append(rows);
      } else {
        commentSection.append(element('p', 'fb-hint', 'No comments.'));
      }
      body.append(commentSection);

      const checkpoints = visibleCheckpoints(state.data);
      if (checkpoints.length) {
        const section = element('section', 'fb-panel__section');
        section.append(element('h3', 'fb-panel__heading', `Checkpoints (${checkpoints.length})`));
        const rows = element('ul', 'fb-thread');
        for (const entry of checkpoints) {
          const row = element('li', 'fb-thread__row');
          row.append(element('span', 'fb-thread__who', entry.agent || 'unknown'));
          row.append(element('span', 'fb-thread__when', dateText(entry.timestamp)));
          // `progress` is a number (or null), so 0 is a real value and must not
        // be dropped the way a falsy check would drop it.
        const hasProgress = typeof entry.progress === 'number' && Number.isFinite(entry.progress);
        const text = hasProgress ? `${entry.message || ''} (${entry.progress}%)` : entry.message || '';
          row.append(element('p', 'fb-thread__text', text));
          rows.append(row);
        }
        section.append(rows);
        body.append(section);
      }

      if (dashboardUrl) {
        const link = element('a', 'fb-panel__link', 'Open in FlowBoard ↗');
        link.href = buildFrameUrl(dashboardUrl, { project: state.project, task: state.id });
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.title = 'The full task in the FlowBoard dashboard, with rich text and every comment';
        body.append(link);
      }

      menuButton.onclick = () => onMenu(menuButton, task);
    },
  };
}

/* ------------------------------------------------------------------- page */

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    // Bind the operator profile once per connection, before any view mounts.
    const identity = createIdentityBinder(host);
    void identity.ensure();

    const disposers = [
      host.ui.registerNavigation({
        id: PAGE_ID,
        label: 'FlowBoard',
        page: { id: PAGE_ID },
        icon: 'kanban',
      }),
      host.ui.registerPage({
        id: PAGE_ID,
        label: 'FlowBoard',
        mount: (container, context) => mountPage(container, context, identity),
      }),
    ];

    return () => {
      identity.dispose();
      for (const dispose of disposers) dispose?.();
    };
  },
});

/**
 * The feature client over a transport that remembers *why* a call was refused.
 *
 * `createFeatureClient` throws a plain `Error(message)` for a failed
 * operation and drops the rest of the refusal envelope, so FlowBoard's error
 * code — the difference between "you cannot do that" and "that task is gone"
 * — never reaches the page through the thrown error. Reading it off the
 * transport keeps the contract client as the only caller while still letting
 * the board react to the code; a host that does attach a code to the error
 * keeps working unchanged, and a host that sends none simply yields no code.
 *
 * Codes are kept per operation and consumed on read, because only one write
 * is ever in flight and the queries that refresh underneath it have their own
 * operation ids.
 */
function createTracingClient(host) {
  const codes = new Map();
  const transport = {
    pluginId: host.pluginId,
    get signal() {
      return host.signal;
    },
    get connection() {
      return host.connection;
    },
    request: async (method, params) => {
      const result = await host.request(method, params);
      if (method === 'plugins.sessionAction' && result && result.ok !== true) {
        const code = typeof result.code === 'string' ? result.code : null;
        if (params?.actionId) codes.set(params.actionId, code);
      }
      return result;
    },
    onEvent: (event, listener) => host.onEvent(event, listener),
    subscribe: (listener) => host.subscribe(listener),
  };
  return {
    feature: createFeatureClient(contract, transport),
    takeCode: (operation) => {
      const code = codes.get(operation) ?? null;
      codes.delete(operation);
      return code;
    },
  };
}

function mountPage(container, context, identity) {
  const { feature, takeCode } = createTracingClient(context.host);
  const store = storage();
  let agentId = readAgentId(store);
  let view = initialViewState(readPageParams(context.props));
  let dashboardUrl = '';
  let unwatchStatus = null;
  let unwatchTasks = null;
  let watchedTasksKey = null;
  let boardFilter = '';
  let unwatchDetail = null;
  let watchedTask = '';
  let focusedProject = null;
  let frameLoadedFor = '';
  let panelOpener = null;

  const state = {
    projects: initialWatchState(),
    needs: initialWatchState(),
    status: initialWatchState(),
    tasks: initialWatchState(),
    panel: initialPanelState(),
    actions: initialActionState(),
  };

  const root = element('section', 'flowboard-page');
  root.id = 'flowboard-page';

  /* rail header: collapse toggle, agent setting, connection */
  const rail = element('div', 'fb-rail');
  rail.id = 'flowboard-rail';
  const head = element('div', 'fb-rail__head');

  const toggle = button('fb-rail__toggle');
  toggle.id = 'flowboard-rail-toggle';
  toggle.setAttribute('aria-controls', 'flowboard-rail-body');

  const agentLabel = element('label', 'fb-agent');
  agentLabel.htmlFor = 'flowboard-agent-id';
  agentLabel.append(element('span', 'fb-agent__label', 'Agent'));
  const agentInput = document.createElement('input');
  agentInput.className = 'fb-agent__input';
  agentInput.id = 'flowboard-agent-id';
  agentInput.type = 'text';
  agentInput.maxLength = 64;
  agentInput.spellcheck = false;
  agentInput.value = agentId;
  agentInput.title = `Which agent's project binding this rail shows and changes (default ${DEFAULT_AGENT_ID}).`;
  agentLabel.append(agentInput);

  const connection = element('span', 'fb-conn');
  connection.setAttribute('role', 'status');

  head.append(toggle, agentLabel, connection);

  const railBody = element('div', 'fb-rail__body');
  railBody.id = 'flowboard-rail-body';

  const switcher = createProjectSwitcher({ onSelect: (project) => setActiveProject(project) });
  const needsMe = createNeedsMe({ onOpen: (item) => openTask(item.project, item.id) });
  needsMe.setSelected(view.project, view.task);
  switcher.setViewing(view.project);
  railBody.append(switcher.section, needsMe.section);

  const statusLine = element('p', 'fb-statusline');
  statusLine.id = 'flowboard-statusline';
  statusLine.setAttribute('role', 'status');

  rail.append(head, railBody, statusLine);

  /* main area: tab strip, the native board, the framed SPA, the panel */
  const main = element('div', 'fb-main');
  const tabStrip = element('div', 'fb-tabs');
  tabStrip.setAttribute('role', 'tablist');
  tabStrip.setAttribute('aria-label', 'FlowBoard views');
  const tabButtons = new Map();
  for (const tab of TABS) {
    const node = button('fb-tabs__tab', tab.label);
    node.setAttribute('role', 'tab');
    node.id = `flowboard-tab-${tab.id}`;
    node.dataset.fbTab = tab.id;
    node.setAttribute('aria-controls', 'flowboard-main-body');
    node.onclick = () => dispatchView({ type: 'tab', tab: tab.id });
    node.onkeydown = (event) => {
      const index = TABS.findIndex((entry) => entry.id === tab.id);
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        event.preventDefault();
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const target = TABS[(index + delta + TABS.length) % TABS.length];
        tabButtons.get(target.id)?.focus();
        dispatchView({ type: 'tab', tab: target.id });
      }
    };
    tabButtons.set(tab.id, node);
    tabStrip.append(node);
  }
  const externalLink = element('a', 'fb-tabs__external', 'Open in FlowBoard ↗');
  externalLink.target = '_blank';
  externalLink.rel = 'noopener noreferrer';
  externalLink.title = 'Open the full FlowBoard dashboard in a new tab';
  externalLink.hidden = true;
  tabStrip.append(externalLink);

  const mainBody = element('div', 'fb-main__body');
  mainBody.id = 'flowboard-main-body';
  mainBody.setAttribute('role', 'tabpanel');

  const menu = createMenuLayer({ onSubmit: (request) => submitAction(request) });

  const board = createBoard({
    onOpenTask: (task) => openTask(view.project, task.id),
    onMenu: (anchor, task) => menu.open({ anchor, project: view.project, task, bounds: root }),
    onMove: (id, status) => moveTask(id, status),
    onRedrawn: (resolve) => menu.retarget(resolve),
    onFilter: (status) => {
      boardFilter = status;
      watchTasks();
      render();
    },
  });
  board.element.setAttribute('role', 'region');
  board.element.setAttribute('aria-label', 'Kanban board');

  const frameHost = element('div', 'fb-frame-host');
  const frame = document.createElement('iframe');
  frame.className = 'fb-frame';
  frame.id = 'flowboard-frame';
  frame.title = 'FlowBoard';
  frame.setAttribute('style', 'width:100%;height:100%;border:0');
  frameHost.append(frame);

  const panel = createPanel({
    onClose: () => closePanel(),
    onMenu: (anchor, task) => menu.open({ anchor, project: state.panel.project, task, bounds: root }),
  });

  mainBody.append(board.element, frameHost, panel.element);
  main.append(tabStrip, mainBody);
  root.append(rail, main, menu.element);
  container.append(root);

  /* ---------------------------------------------------------- behaviour */

  let collapsed = readRailCollapsed(store);
  function applyCollapsed() {
    rail.dataset.fbCollapsed = collapsed ? 'true' : 'false';
    railBody.hidden = collapsed;
    toggle.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggle.textContent = collapsed ? 'FlowBoard ▸' : 'FlowBoard ▾';
    toggle.title = collapsed ? 'Show the FlowBoard rail' : 'Collapse the FlowBoard rail';
  }
  toggle.onclick = () => {
    collapsed = !collapsed;
    writeRailCollapsed(store, collapsed);
    applyCollapsed();
  };
  applyCollapsed();

  agentInput.onchange = () => {
    const next = writeAgentId(store, agentInput.value);
    if (!next) {
      agentInput.value = agentId;
      statusLine.dataset.fbError = 'agent';
      statusLine.textContent = 'That is not a valid agent id (lowercase kebab-case, e.g. claude-code).';
      return;
    }
    delete statusLine.dataset.fbError;
    agentId = next;
    agentInput.value = next;
    watchStatus();
    render();
  };

  // Escape anywhere in the page closes the menu first, then the panel.
  root.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return;
    if (menu.isOpen()) return; // the menu handles and stops its own Escape
    if (state.panel.open) {
      event.preventDefault();
      closePanel();
    }
  });

  const onPointerDown = (event) => {
    if (!menu.isOpen()) return;
    if (menu.element.contains(event.target)) return;
    // A press on a menu button is that button's own toggle; closing here
    // first would make the second click reopen the menu instead of shutting
    // it.
    if (event.target?.closest?.('[aria-controls="flowboard-menu"]')) return;
    menu.close({ restoreFocus: false });
  };
  document.addEventListener('pointerdown', onPointerDown, true);

  function render() {
    switcher.render(state.projects, state.status.data?.activeProject ?? null);
    needsMe.render(state.needs);
    renderTabs();
    board.render(state.tasks, {
      project: view.project,
      actions: state.actions,
      selected: view.task,
      now: Date.now(),
      filter: boardFilter,
    });
    panel.render(state.panel, { dashboardUrl, actions: state.actions });
    renderStatusLine();
  }

  function renderTabs() {
    for (const tab of TABS) {
      const node = tabButtons.get(tab.id);
      const active = tab.id === view.tab;
      node.setAttribute('aria-selected', active ? 'true' : 'false');
      node.tabIndex = active ? 0 : -1;
      node.dataset.fbActive = active ? 'true' : 'false';
      node.disabled = tab.kind === 'framed' && !dashboardUrl;
      node.title = node.disabled
        ? 'FlowBoard is not configured — set the plugin option "dashboardBaseUrl".'
        : `${tab.label} view`;
    }
    mainBody.setAttribute('aria-labelledby', `flowboard-tab-${view.tab}`);
    const framed = isFramedTab(view.tab);
    board.element.hidden = framed;
    frameHost.hidden = !framed;
    externalLink.hidden = !dashboardUrl;
    if (dashboardUrl) {
      externalLink.href = buildFrameUrl(dashboardUrl, { project: view.project, task: view.task });
    }
    applyFrame();
  }

  function renderStatusLine() {
    if (statusLine.dataset.fbError) return;
    const binding = state.status.data?.binding;
    const active = state.status.data?.activeProject;
    const scope = binding?.scope;
    const parts = [
      active ? `${agentId} → ${active}` : `${agentId} → no active project`,
      scope ? `${scope} binding` : 'no binding',
      binding?.contextReady ? 'context ready' : 'context not ready',
      `refreshed ${clockTime(state.tasks.updatedAt ?? state.needs.updatedAt ?? state.projects.updatedAt)}`,
      context.host.connection?.connected ? 'connected' : 'disconnected',
    ];
    if (view.project) parts.push(`board: ${view.project}`);
    statusLine.textContent = parts.join(' · ');
  }

  function applyConnection() {
    const connected = context.host.connection?.connected;
    connection.dataset.fbConnected = connected ? 'true' : 'false';
    connection.textContent = connected ? 'live' : 'offline';
  }

  /**
   * The iframe is loaded lazily and only re-pointed when a framed tab is
   * actually showing something else — switching to the native board and back
   * must never reload the SPA.
   */
  function applyFrame() {
    if (!dashboardUrl || !isFramedTab(view.tab)) return;
    const next = buildFrameUrl(dashboardUrl, { project: view.project, agentId });
    if (frameLoadedFor === next) return;
    frameLoadedFor = next;
    frame.src = next;
  }

  function dispatchView(action) {
    const next = viewReducer(view, action);
    if (next === view) return;
    const projectChanged = next.project !== view.project;
    const taskChanged = next.task !== view.task;
    view = next;
    switcher.setViewing(view.project);
    needsMe.setSelected(view.project, view.task);
    if (projectChanged) {
      state.actions = actionReducer(state.actions, { type: 'clear' });
      watchTasks();
      syncFocus();
    }
    if (taskChanged) syncPanel();
    writePageParams();
    render();
  }

  function writePageParams() {
    const params = buildPageParams(selectionOf(view));
    try {
      context.host.navigation?.openPage?.({ id: PAGE_ID, params }, { replace: true });
    } catch {
      /* navigation is a convenience; the view state above is the effect */
    }
  }

  function openTask(project, id) {
    // Whatever was focused when the task was opened is where Escape returns.
    if (!state.panel.open) panelOpener = document.activeElement ?? null;
    dispatchView({ type: 'task', project, id });
  }

  function closePanel() {
    const opener = panelOpener;
    panelOpener = null;
    dispatchView({ type: 'close-task' });
    if (opener?.isConnected) opener.focus?.();
  }

  async function setActiveProject(project) {
    try {
      // `sessionKey` is deliberately omitted: the rail switches the agent-level
      // binding, the one every session of that agent falls back to (ADR-0039).
      await identity.ensure();
      const result = await feature.invoke('status.set', { agentId, project });
      if (context.signal.aborted) return;
      state.status = watchReducer(state.status, { type: 'data', data: result, at: Date.now() });
      dispatchView({ type: 'project', project });
      render();
    } catch (error) {
      if (context.signal.aborted) return;
      statusLine.dataset.fbError = 'status';
      statusLine.textContent = `Could not switch project: ${errorText(error)}`;
      globalThis.setTimeout(() => {
        delete statusLine.dataset.fbError;
        render();
      }, 4000);
    }
  }

  /* ------------------------------------------------------------ actions */

  function taskById(id) {
    return (state.tasks.data?.tasks ?? []).find((task) => task.id === id) || null;
  }

  /**
   * Fold the task an action returned back into the board and the panel. This
   * is the server's answer, not an optimistic guess: it is what the watch
   * refresh will confirm a moment later.
   */
  function reconcile(task) {
    if (!task?.id) return;
    const rows = state.tasks.data?.tasks;
    if (Array.isArray(rows)) {
      const index = rows.findIndex((row) => row.id === task.id);
      const next = index >= 0 ? rows.map((row, at) => (at === index ? { ...row, ...task } : row)) : [...rows, task];
      state.tasks = { ...state.tasks, data: { ...state.tasks.data, tasks: next } };
    }
    if (state.panel.open && state.panel.id === task.id && state.panel.data) {
      state.panel = panelReducer(state.panel, {
        type: 'data',
        for: { project: state.panel.project, id: state.panel.id },
        data: { ...state.panel.data, task: { ...state.panel.data.task, ...task } },
        at: Date.now(),
      });
    }
    board.invalidate();
    panel.invalidate();
  }

  /**
   * Run one contract action. Returns `{ error }` synchronously when the form
   * still owes something, so the menu can keep itself open and say so.
   */
  function submitAction({ project, task, item, reason }) {
    const request = actionRequest({ project: project || view.project, task, item, reason });
    if (request.error) return { error: request.error };
    return { ok: true, run: () => void runAction(request.operation, request.input, task.id) };
  }

  function moveTask(id, status) {
    const task = taskById(id);
    if (!task) return;
    const request = dropRequest({ project: view.project, task, status });
    if (request.noop || request.error) return;
    void runAction(request.operation, request.input, id);
  }

  async function runAction(operation, input, id) {
    state.actions = actionReducer(state.actions, { type: 'start', id });
    board.invalidate();
    panel.invalidate();
    render();
    try {
      await identity.ensure();
      const result = await feature.invoke(operation, input);
      if (context.signal.aborted) return;
      state.actions = actionReducer(state.actions, { type: 'settled', id });
      reconcile(result?.task);
    } catch (error) {
      if (context.signal.aborted) return;
      // The backend's own message, verbatim: it is the only thing that can
      // explain a FlowBoard policy refusal (a lease, the approve gate, a
      // project rule) and guessing here would hide it.
      state.actions = actionReducer(state.actions, { type: 'failed', id, error, code: takeCode(operation) });
      // A task FlowBoard says is gone cannot be shown any more; leaving the
      // panel open on it would keep offering actions against nothing.
      if (state.actions.code === 'flowboard_not_found' && state.panel.id === id) {
        dispatchView({ type: 'close-task' });
      }
      board.invalidate();
      panel.invalidate();
    }
    render();
  }

  /* ------------------------------------------------------------ watches */

  /**
   * `feature.watch` throws synchronously when the contract this bundle was
   * built with has no such query — which is what a half-upgraded install
   * looks like, plugin code newer or older than the contract beside it. A
   * view that cannot be watched must degrade to its own error state, the same
   * as one whose request failed; it must never take the whole page down and
   * with it the rail and the board that do work.
   */
  function safeWatch(operation, input, options) {
    try {
      return feature.watch(operation, input, options);
    } catch (error) {
      options.onError?.(error instanceof Error ? error : new Error(String(error)));
      return () => {};
    }
  }

  function watchStatus() {
    unwatchStatus?.();
    unwatchStatus = safeWatch(
      'status.get',
      { agentId },
      {
        events: ['projects-changed'],
        onChange: (result) => {
          state.status = watchReducer(state.status, { type: 'data', data: result, at: Date.now() });
          // Without a selection the board follows the agent's active project,
          // so opening the page lands on the project the agent is working in.
          if (!view.project && result?.activeProject) {
            dispatchView({ type: 'project', project: result.activeProject });
            return;
          }
          render();
        },
        onError: (error) => {
          state.status = watchReducer(state.status, { type: 'error', error });
          render();
        },
      },
    );
  }

  function watchTasks() {
    // One watch per project *and* filter: changing either asks a different
    // question, and the answer to the old one must not land in the new view.
    const key = view.project ? `${view.project}|${boardFilter}` : '';
    if (watchedTasksKey === key) return;
    watchedTasksKey = key;
    unwatchTasks?.();
    unwatchTasks = null;
    state.tasks = initialWatchState();
    board.invalidate();
    if (!view.project) {
      render();
      return;
    }
    const project = view.project;
    const input = { project, limit: BOARD_TASK_LIMIT };
    if (boardFilter) input.status = boardFilter;
    unwatchTasks = safeWatch(
      'tasks.list',
      input,
      {
        // `tasks-changed` may carry the project and the ids that moved; this
        // refetches the whole list either way, which is a superset of what
        // the payload asks for and stays correct when the same write is
        // announced twice (FlowBoard deliberately re-announces after ~5 s).
        events: ['tasks-changed'],
        onChange: (result) => {
          if (watchedTasksKey !== key) return;
          state.tasks = watchReducer(state.tasks, {
            type: 'data',
            data: result,
            at: Date.now(),
            empty: !(result?.tasks?.length > 0),
          });
          board.invalidate();
          render();
        },
        onError: (error) => {
          if (watchedTasksKey !== key) return;
          state.tasks = watchReducer(state.tasks, { type: 'error', error });
          board.invalidate();
          render();
        },
      },
    );
  }

  function syncPanel() {
    const key = view.project && view.task ? `${view.project}/${view.task}` : '';
    if (key === watchedTask) return;
    watchedTask = key;
    unwatchDetail?.();
    unwatchDetail = null;
    if (!key) {
      state.panel = panelReducer(state.panel, { type: 'close' });
      panel.invalidate();
      return;
    }
    const target = { project: view.project, id: view.task };
    state.panel = panelReducer(state.panel, { type: 'open', ...target });
    panel.invalidate();
    let focused = false;
    unwatchDetail = safeWatch(
      'task.get',
      target,
      {
        events: ['tasks-changed'],
        onChange: (result) => {
          if (watchedTask !== key) return;
          state.panel = panelReducer(state.panel, { type: 'data', for: target, data: result, at: Date.now() });
          panel.invalidate();
          render();
          // Focus moves into the panel once, when it first has something to
          // read — a screen reader must not be sent to an empty drawer, and a
          // background refresh must not drag the caret back out of the board.
          if (!focused && state.panel.phase === 'ready') {
            focused = true;
            panel.heading.focus?.();
          }
        },
        onError: (error) => {
          if (watchedTask !== key) return;
          state.panel = panelReducer(state.panel, { type: 'error', for: target, error });
          panel.invalidate();
          render();
        },
      },
    );
  }

  /**
   * Tell FlowBoard which project this page is on. The backend polls for
   * changes per focused project, so an unfocused page costs nothing and a
   * disposed one must not leave a poll running.
   */
  function syncFocus() {
    const wanted = focusProject(view);
    if (wanted === focusedProject) return;
    focusedProject = wanted;
    void identity
      .ensure()
      .then(() => feature.invoke('ui.focus', { project: wanted }))
      .catch(() => {
        /* focus is an optimization for the change poll, never a gate */
      });
  }

  const unwatchProjects = safeWatch(
    'projects.list',
    {},
    {
      events: ['projects-changed', 'tasks-changed'],
      onChange: (result) => {
        state.projects = watchReducer(state.projects, {
          type: 'data',
          data: result,
          at: Date.now(),
          empty: !(result?.projects?.length > 0),
        });
        render();
      },
      onError: (error) => {
        state.projects = watchReducer(state.projects, { type: 'error', error });
        render();
      },
    },
  );

  const unwatchNeeds = safeWatch(
    'tasks.needing-me',
    { limit: NEEDS_ME_LIMIT },
    {
      events: ['tasks-changed', 'projects-changed'],
      onChange: (result) => {
        state.needs = watchReducer(state.needs, {
          type: 'data',
          data: result,
          at: Date.now(),
          empty: !(result?.items?.length > 0),
        });
        render();
      },
      onError: (error) => {
        state.needs = watchReducer(state.needs, { type: 'error', error });
        render();
      },
    },
  );

  watchStatus();
  watchTasks();
  syncPanel();
  syncFocus();
  applyConnection();
  render();

  const unsubscribe = context.host.subscribe?.(() => {
    applyConnection();
    renderStatusLine();
  });

  void (async () => {
    await identity.ensure();
    if (context.signal.aborted) return;
    try {
      const config = await feature.invoke('ui.config', {});
      if (context.signal.aborted) return;
      if (!config.dashboardUrl) {
        statusLine.dataset.fbError = 'config';
        statusLine.textContent = 'FlowBoard is not configured. Set the plugin option "dashboardBaseUrl".';
        render();
        return;
      }
      dashboardUrl = config.dashboardUrl;
      panel.invalidate();
      render();
    } catch (error) {
      if (context.signal.aborted) return;
      statusLine.dataset.fbError = 'config';
      statusLine.textContent = `FlowBoard configuration unavailable: ${errorText(error)}`;
    }
  })();

  return {
    update: (next) => {
      const params = readPageParams(next.props);
      dispatchView({ type: 'params', project: params.project, task: params.task });
    },
    dispose: () => {
      // Clear the backend's per-project poll before the connection goes.
      if (focusedProject) {
        focusedProject = null;
        void feature.invoke('ui.focus', { project: null }).catch(() => {});
      }
      document.removeEventListener('pointerdown', onPointerDown, true);
      menu.close({ restoreFocus: false });
      unwatchProjects();
      unwatchNeeds();
      unwatchStatus?.();
      unwatchTasks?.();
      unwatchDetail?.();
      unsubscribe?.();
      root.remove();
    },
  };
}
