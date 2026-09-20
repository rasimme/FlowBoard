/**
 * FlowBoard native Control UI page — stage 1 (T-487-8).
 *
 * The page is a native rail over the framed FlowBoard SPA. The rail is the
 * part OpenClaw operators actually need without leaving the Gateway, and it is
 * built entirely on the feature contract (openclaw/contract.js), so the host
 * validates every payload and enforces `operator.read` / `operator.write`
 * before a FlowBoard handler runs:
 *
 *  - **Projects** — `projects.list` plus `status.get` for the configured
 *    agent; clicking one writes `status.set`. This is FlowBoard's "which
 *    project is this agent working in" switch, which previously required the
 *    dashboard or the API.
 *  - **Tasks needing me** — `tasks.needing-me`, grouped into the approve gate
 *    and stalled work. FlowBoard's premise is "I come back — what needs me?";
 *    this is that question answered inside the Gateway.
 *  - **Status line** — the active project, which binding layer answered, when
 *    the data last refreshed, and whether the Gateway connection is live.
 *
 * Both lists use `feature.watch`, so they refresh on contract events and after
 * a reconnect and never poll from the browser. The stage-0 iframe stays as the
 * main area until stage 2 makes the board native.
 *
 * Everything runs through `createFeatureClient(contract, context.host)`, so the
 * browser bundle shares the exact schemas the backend validates against. All
 * ids and classes are `fb-` / `flowboard-` namespaced so independently bundled
 * plugin UIs cannot collide with them, and the styling inherits the host's own
 * theme tokens rather than shipping a palette (see index.css).
 */
import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';

import { contract } from '../contract.js';
import { buildFrameUrl, buildPageParams, readPageParams } from './lib/deep-link.js';
import { countNeedsMe, describeNeedsMe, groupNeedsMe, reasonLabel } from './lib/needs-me.js';
import {
  DEFAULT_AGENT_ID,
  readAgentId,
  readRailCollapsed,
  writeAgentId,
  writeRailCollapsed,
} from './lib/settings.js';
import { initialWatchState, watchReducer } from './lib/watch-state.js';
import './index.css';

const PAGE_ID = 'flowboard';
const NEEDS_ME_LIMIT = 40;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
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
      row.append(element('span', 'fb-chip__name', project.name));
      const needs = (project.counts?.review || 0) + (project.counts?.blocked || 0);
      if (needs > 0) {
        const badge = element('span', 'fb-chip__badge', String(needs));
        badge.title = `${project.counts.review} in review, ${project.counts.blocked} blocked`;
        row.append(badge);
      }
      row.title = active
        ? `${project.name} — active for this agent`
        : `Switch this agent to ${project.name}`;
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
    render(state, activeProject) {
      const projects = state.data?.projects ?? [];
      const next = `${state.phase}|${activeProject ?? ''}|${projects
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
        body.append(element('p', 'fb-hint', 'No projects yet. Create one in the board below.'));
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
    row.title = `${item.project} · ${item.id} — open in the board below`;
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

function mountPage(container, context, identity) {
  const feature = createFeatureClient(contract, context.host);
  const store = storage();
  let agentId = readAgentId(store);
  let selection = readPageParams(context.props);
  let dashboardUrl = '';
  let unwatchStatus = null;

  const state = {
    projects: initialWatchState(),
    needs: initialWatchState(),
    status: initialWatchState(),
  };

  const root = element('section', 'flowboard-page');
  root.id = 'flowboard-page';

  /* rail header: collapse toggle, agent setting, connection */
  const rail = element('div', 'fb-rail');
  rail.id = 'flowboard-rail';
  const head = element('div', 'fb-rail__head');

  const toggle = element('button', 'fb-rail__toggle');
  toggle.type = 'button';
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

  const body = element('div', 'fb-rail__body');
  body.id = 'flowboard-rail-body';

  const switcher = createProjectSwitcher({
    onSelect: (project) => setActiveProject(project),
  });
  const needsMe = createNeedsMe({ onOpen: (item) => openTask(item) });
  // A page reopened from a deep link starts with its row already marked.
  needsMe.setSelected(selection.project, selection.task);
  body.append(switcher.section, needsMe.section);

  const statusLine = element('p', 'fb-statusline');
  statusLine.id = 'flowboard-statusline';
  statusLine.setAttribute('role', 'status');

  rail.append(head, body, statusLine);

  const frameHost = element('div', 'fb-frame-host');
  const frame = document.createElement('iframe');
  frame.className = 'fb-frame';
  frame.id = 'flowboard-frame';
  frame.title = 'FlowBoard';
  frame.setAttribute('style', 'width:100%;height:100%;border:0');
  frameHost.append(frame);

  root.append(rail, frameHost);
  container.append(root);

  /* ---------------------------------------------------------- behaviour */

  let collapsed = readRailCollapsed(store);
  function applyCollapsed() {
    rail.dataset.fbCollapsed = collapsed ? 'true' : 'false';
    body.hidden = collapsed;
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

  function render() {
    switcher.render(state.projects, state.status.data?.activeProject ?? null);
    needsMe.render(state.needs);
    renderStatusLine();
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
      `refreshed ${clockTime(state.needs.updatedAt ?? state.projects.updatedAt)}`,
      context.host.connection?.connected ? 'connected' : 'disconnected',
    ];
    if (selection.task) {
      // Deliberately unconditional: the SPA picks its own project from the
      // agent binding it resolves, so the rail cannot promise that the board
      // below is showing this task. See lib/deep-link.js.
      parts.push(`focused ${selection.task} in ${selection.project} — the board below does not follow deep links yet`);
    }
    statusLine.textContent = parts.join(' · ');
  }

  function applyConnection() {
    const connected = context.host.connection?.connected;
    connection.dataset.fbConnected = connected ? 'true' : 'false';
    connection.textContent = connected ? 'live' : 'offline';
  }

  function applyFrame() {
    if (!dashboardUrl) return;
    const next = buildFrameUrl(dashboardUrl, {
      project: selection.project,
      task: selection.task,
      focus: selection.task ? String(Date.now()) : '',
    });
    if (frame.src !== next) frame.src = next;
  }

  function applySelection(next) {
    selection = next;
    needsMe.setSelected(next.project, next.task);
    applyFrame();
    render();
  }

  async function setActiveProject(project) {
    try {
      // `sessionKey` is deliberately omitted: the rail switches the agent-level
      // binding, the one every session of that agent falls back to (ADR-0039).
      await identity.ensure();
      const result = await feature.invoke('status.set', { agentId, project });
      if (context.signal.aborted) return;
      state.status = watchReducer(state.status, { type: 'data', data: result, at: Date.now() });
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

  function openTask(item) {
    const params = buildPageParams({ project: item.project, task: item.id });
    // The canonical deep link lives in the Control UI URL, so the selection
    // survives a reload and can be shared. `update` applies it; the fallback
    // below covers a host that answers with the same props object.
    try {
      context.host.navigation?.openPage?.({ id: PAGE_ID, params }, { replace: true });
    } catch {
      /* navigation is a convenience; the frame update below is the effect */
    }
    applySelection({ project: item.project, task: item.id });
  }

  /* ------------------------------------------------------------ watches */

  function watchStatus() {
    unwatchStatus?.();
    unwatchStatus = feature.watch(
      'status.get',
      { agentId },
      {
        events: ['projects-changed'],
        onChange: (result) => {
          state.status = watchReducer(state.status, { type: 'data', data: result, at: Date.now() });
          render();
        },
        onError: (error) => {
          state.status = watchReducer(state.status, { type: 'error', error });
          render();
        },
      },
    );
  }

  const unwatchProjects = feature.watch(
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

  const unwatchNeeds = feature.watch(
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
        return;
      }
      dashboardUrl = config.dashboardUrl;
      applyFrame();
      if (!frame.src) frame.src = dashboardUrl;
    } catch (error) {
      if (context.signal.aborted) return;
      statusLine.dataset.fbError = 'config';
      statusLine.textContent = `FlowBoard configuration unavailable: ${errorText(error)}`;
    }
  })();

  return {
    update: (next) => applySelection(readPageParams(next.props)),
    dispose: () => {
      unwatchProjects();
      unwatchNeeds();
      unwatchStatus?.();
      unsubscribe?.();
      root.remove();
    },
  };
}
