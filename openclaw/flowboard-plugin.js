import projectContextHandler from '../hooks/project-context/handler.js';

export default {
  id: 'flowboard',
  name: 'FlowBoard',
  description: 'Project workspaces, dashboard, and project-context hook for OpenClaw agents.',
  register(api) {
    api.registerHook('agent:bootstrap', projectContextHandler, {
      name: 'project-context',
      description: 'Live-injects active FlowBoard project context before every agent run',
    });
  },
};
