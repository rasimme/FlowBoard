/**
 * FlowBoard native Control UI entry (T-487-7).
 *
 * The page keeps the framed FlowBoard SPA from the T-487-4 spike and puts a
 * native, contract-driven strip above it:
 *
 *  - `feature.watch('projects.list', …)` renders the project chips and
 *    refreshes on the `projects-changed` event and after a reconnect. No
 *    polling.
 *  - A minimal "Quick task" form calls the `task.create` action. It is the
 *    smallest write path that proves end-to-end attribution: the task lands in
 *    FlowBoard with the signed-in Gateway operator as its principal. T-487-8
 *    replaces this UI with the real native board.
 *
 * Everything runs through `createFeatureClient(contract, context.host)`, so the
 * browser bundle shares the exact schemas the backend validates against. All
 * ids and classes are `fb-` / `flowboard-` namespaced so independently bundled
 * plugin UIs cannot collide with them.
 */
import { defineControlUiPlugin } from 'openclaw/plugin-sdk/control-ui';
import { createFeatureClient } from 'openclaw/plugin-sdk/feature-contract';

import { contract, TASK_PRIORITIES } from '../contract.js';
import './index.css';

const PAGE_ID = 'flowboard';

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function createStrip() {
  const strip = element('div', 'fb-native-projects');
  const label = element('span', 'fb-native-projects__label', 'Projects');
  const list = element('span', 'fb-native-projects__list', 'Loading…');
  strip.append(label, list);
  return { strip, list };
}

function renderProjects(list, projects) {
  list.replaceChildren();
  if (!projects.length) {
    list.textContent = 'No projects yet';
    return;
  }
  for (const project of projects) {
    const chip = element('span', 'fb-native-projects__chip', project.name);
    chip.dataset.fbStatus = project.status || 'unknown';
    chip.title = `${project.name} — ${project.status || 'unknown'}`;
    list.append(chip);
  }
}

/** Minimal create form: project, title, priority. Attribution proof, not a board. */
function createQuickTaskForm(feature, signal) {
  const form = element('form', 'fb-quick-task');
  form.id = 'flowboard-quick-task';

  const project = document.createElement('select');
  project.className = 'fb-quick-task__project';
  project.id = 'flowboard-quick-task-project';
  project.setAttribute('aria-label', 'Project for the new task');
  project.disabled = true;

  const title = document.createElement('input');
  title.className = 'fb-quick-task__title';
  title.id = 'flowboard-quick-task-title';
  title.type = 'text';
  title.maxLength = 128;
  title.placeholder = 'Quick task title';
  title.setAttribute('aria-label', 'Title of the new task');

  const priority = document.createElement('select');
  priority.className = 'fb-quick-task__priority';
  priority.id = 'flowboard-quick-task-priority';
  priority.setAttribute('aria-label', 'Priority of the new task');
  for (const value of TASK_PRIORITIES) {
    const option = document.createElement('option');
    option.value = value;
    option.textContent = value;
    if (value === 'medium') option.selected = true;
    priority.append(option);
  }

  const submit = document.createElement('button');
  submit.className = 'fb-quick-task__submit';
  submit.id = 'flowboard-quick-task-submit';
  submit.type = 'submit';
  submit.textContent = 'Create task';

  const status = element('output', 'fb-quick-task__status');
  status.id = 'flowboard-quick-task-status';
  status.setAttribute('aria-live', 'polite');

  form.append(project, title, priority, submit, status);

  form.onsubmit = async (event) => {
    event.preventDefault();
    const selected = project.value;
    const text = title.value.trim();
    if (!selected || !text) {
      status.textContent = 'Pick a project and enter a title.';
      return;
    }
    submit.disabled = true;
    status.textContent = 'Creating…';
    try {
      const created = await feature.invoke('task.create', {
        project: selected,
        title: text,
        priority: priority.value,
      });
      if (signal.aborted) return;
      status.textContent = `Created ${created.id} in ${selected}`;
      status.dataset.fbTaskId = created.id;
      title.value = '';
    } catch (error) {
      if (signal.aborted) return;
      status.textContent = `Could not create the task: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      if (!signal.aborted) submit.disabled = false;
    }
  };

  return {
    form,
    setProjects(projects) {
      const previous = project.value;
      project.replaceChildren();
      for (const entry of projects) {
        const option = document.createElement('option');
        option.value = entry.name;
        option.textContent = entry.name;
        project.append(option);
      }
      project.disabled = projects.length === 0;
      if (previous && projects.some((entry) => entry.name === previous)) project.value = previous;
    },
  };
}

export default defineControlUiPlugin({
  id: contract.pluginId,
  activate(host) {
    host.ui.registerNavigation({
      id: PAGE_ID,
      label: 'FlowBoard',
      page: { id: PAGE_ID },
      icon: 'kanban',
    });

    host.ui.registerPage({
      id: PAGE_ID,
      label: 'FlowBoard',
      mount(container, context) {
        const feature = createFeatureClient(contract, context.host);

        const root = element('section', 'flowboard-page');
        root.id = 'flowboard-page';

        const { strip, list } = createStrip();
        const quickTask = createQuickTaskForm(feature, context.signal);

        const status = element('p', 'fb-status', 'Connecting to FlowBoard…');
        status.setAttribute('role', 'status');

        const frameHost = element('div', 'fb-frame-host');

        root.append(strip, quickTask.form, status, frameHost);
        container.append(root);

        const mountFrame = (dashboardUrl) => {
          const frame = document.createElement('iframe');
          frame.className = 'fb-frame';
          frame.id = 'flowboard-frame';
          frame.title = 'FlowBoard';
          frame.setAttribute('style', 'width:100%;height:100%;border:0');
          frame.src = dashboardUrl;
          frameHost.replaceChildren(frame);
        };

        void (async () => {
          try {
            // Bind this connection's verified operator profile before the
            // first action runs; the feature transport cannot carry it (see
            // openclaw/feature-entry.js and ADR-0040).
            await context.host.request('flowboard.ui.identity', {});
          } catch {
            // A Gateway without the identity bridge still works: FlowBoard
            // then attributes writes to the trusted local operator.
          }
          if (context.signal.aborted) return;
          try {
            const config = await feature.invoke('ui.config', {});
            if (context.signal.aborted) return;
            if (!config.dashboardUrl) {
              status.textContent = 'FlowBoard is not configured. Set the plugin option "dashboardBaseUrl".';
              return;
            }
            status.hidden = true;
            mountFrame(config.dashboardUrl);
          } catch (error) {
            if (context.signal.aborted) return;
            status.textContent = `FlowBoard configuration unavailable: ${
              error instanceof Error ? error.message : String(error)
            }`;
          }
        })();

        const unwatch = feature.watch(
          'projects.list',
          {},
          {
            events: ['projects-changed'],
            onChange: (result) => {
              const projects = Array.isArray(result?.projects) ? result.projects : [];
              renderProjects(list, projects);
              quickTask.setProjects(projects);
            },
            onError: (error) => {
              list.textContent = `unavailable (${error.message})`;
            },
          },
        );

        return {
          dispose: () => {
            unwatch();
            root.remove();
          },
        };
      },
    });
  },
});
