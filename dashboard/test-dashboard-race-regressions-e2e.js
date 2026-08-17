'use strict';

// T-440 re-review regressions: bootstrap auth priority, AppStateContext's late
// agents response, and project-switch invalidation of an older poll snapshot.

const net = require('net');
const { withDashboard, reporter } = require('./test-support/browser-harness.js');

const r = reporter('Dashboard API race regressions (T-440)');

function getFreePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close((error) => error ? reject(error) : resolve(port));
    });
  });
}

async function main() {
  const port = await getFreePort();
  const res = await withDashboard(async ({ api, page, base }) => {
    const freshAgent = 'fresh-agents-snapshot';
    await api('PUT', '/status', { project: null, agentId: freshAgent });
    await api('POST', '/projects', { name: 'switch-old' });
    await api('POST', '/projects', { name: 'switch-new' });
    const oldTask = (await api('POST', '/projects/switch-old/tasks', { title: 'Old project task' })).body?.task?.id;
    await api('POST', '/projects/switch-new/tasks', { title: 'New project task' });

    await page.evaluateOnNewDocument(() => {
      window.Telegram = {
        WebApp: {
          initData: 'synthetic-e2e-init-data',
          initDataUnsafe: {},
          ready() {},
          expand() {},
          disableVerticalSwipes() {},
          openLink() {},
        },
      };
    });

    let mode = 'pass';
    let authCoreProjects = 0;
    let releaseLateAgents;
    let lateAgentsStartedResolve;
    let lateAgentsStarted = Promise.resolve();
    let releaseOldPoll;
    let oldPollStartedResolve;
    let oldPollStarted = Promise.resolve();
    let oldPollRequestFailed = false;

    const respond = (request, status, body) => request.respond({
      status,
      contentType: 'application/json',
      body: JSON.stringify(body),
    });

    await page.setRequestInterception(true);
    page.on('requestfailed', (request) => {
      const url = new URL(request.url());
      if (url.pathname === '/api/projects/switch-old/tasks') oldPollRequestFailed = true;
    });
    page.on('request', (request) => {
      void (async () => {
        const url = new URL(request.url());
        const loadKind = request.headers()['x-flowboard-load'];

        if (url.hostname === 'telegram.org' && url.pathname.endsWith('/telegram-web-app.js')) {
          await request.respond({
            status: 200,
            contentType: 'application/javascript',
            body: `window.Telegram={WebApp:{initData:'synthetic-e2e-init-data',initDataUnsafe:{},ready(){},expand(){},disableVerticalSwipes(){},openLink(){}}};`,
          });
          return;
        }

        if (request.method() === 'POST' && url.pathname === '/api/auth') {
          if (mode === 'auth-403') {
            await respond(request, 403, { error: 'Synthetic Telegram auth denial' });
            return;
          }
          if (mode === 'auth-recovered-core-500') {
            await respond(request, 200, { ok: true, user: { username: 'e2e' }, agentId: 'e2e' });
            return;
          }
          if (mode === 'auth-malformed') {
            await respond(request, 200, { ok: false, user: {} });
            return;
          }
        }

        if (request.method() === 'GET' && url.pathname === '/api/projects'
          && (mode === 'auth-403' || mode === 'auth-malformed' || mode === 'auth-recovered-core-500')) {
          authCoreProjects += 1;
          if (mode === 'auth-recovered-core-500') {
            await respond(request, 500, { error: 'Synthetic post-auth core failure' });
            return;
          }
        }

        if ((mode === 'late-agents' || mode === 'late-malformed-agents')
          && request.method() === 'GET'
          && url.pathname === '/api/agents'
          && loadKind === 'app-state-initial-agents') {
          lateAgentsStartedResolve();
          await new Promise((resolve) => { releaseLateAgents = resolve; });
          await respond(request, 200, mode === 'late-malformed-agents'
            ? { ok: true, agents: { malformed: true } }
            : {
              ok: true,
              agents: [{ agent_id: 'stale-late-agent', active_project: null }],
            });
          return;
        }

        if (mode === 'hold-old-poll'
          && request.method() === 'GET'
          && url.pathname === '/api/projects/switch-old/tasks') {
          oldPollStartedResolve();
          await new Promise((resolve) => { releaseOldPoll = resolve; });
          await respond(request, 200, { ok: true, tasks: [{ id: oldTask, title: 'Old project task' }] });
          return;
        }

        await request.continue();
      })().catch((error) => {
        if (!/intercept|Invalid Interception|already handled|Target closed/i.test(error.message)) {
          console.error('request interception failed:', error);
        }
      });
    });

    const goto = (caseName) => page.goto(`${base}/?agentId=e2e&case=${caseName}`, { waitUntil: 'domcontentloaded' });
    const connectionState = () => page.evaluate(() => ({
      status: window.appState?.connection?.status,
      scope: window.appState?.connection?.errorScope,
      httpStatus: window.appState?.connection?.httpStatus,
    }));

    // AppStateContext's own /agents load is deliberately late. The complete
    // DashboardContext snapshot must win and remain intact after the late reply.
    mode = 'late-agents';
    lateAgentsStarted = new Promise((resolve) => { lateAgentsStartedResolve = resolve; });
    await goto('late-agents');
    await lateAgentsStarted;
    await page.waitForFunction((id) => window.appState?.agents?.some((agent) => agent.agent_id === id), {}, freshAgent);
    releaseLateAgents();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const agentsAfterLateReply = await page.evaluate(() => window.appState.agents.map((agent) => agent.agent_id));
    r.ok(agentsAfterLateReply.includes(freshAgent), 'complete snapshot survives a delayed AppStateContext agents response');
    r.ok(!agentsAfterLateReply.includes('stale-late-agent'), 'delayed agents response cannot overwrite newer agents data');

    // A malformed late 2xx from AppStateContext must reject without publishing
    // the old [] fallback that used to erase DashboardContext's valid agents.
    mode = 'late-malformed-agents';
    lateAgentsStarted = new Promise((resolve) => { lateAgentsStartedResolve = resolve; });
    await goto('late-malformed-agents');
    await lateAgentsStarted;
    await page.waitForFunction((id) => window.appState?.agents?.some((agent) => agent.agent_id === id), {}, freshAgent);
    releaseLateAgents();
    await new Promise((resolve) => setTimeout(resolve, 300));
    const agentsAfterMalformedReply = await page.evaluate(() => window.appState.agents.map((agent) => agent.agent_id));
    r.ok(agentsAfterMalformedReply.includes(freshAgent),
      'malformed AppStateContext agents 2xx preserves the valid full-snapshot agents');

    // /api/auth itself returns 403 while every core GET is allowed to return
    // 2xx. The auth failure remains the central blocking state.
    mode = 'auth-403';
    authCoreProjects = 0;
    await goto('bootstrap-auth-403');
    await page.waitForFunction(() => window.appState?.connection?.status === 'auth-error');
    await page.waitForFunction(() => Array.isArray(window.appState?.projects) && window.appState.projects.length >= 2);
    const authFailure = await connectionState();
    r.ok(authCoreProjects > 0, 'core /projects completed after the synthetic auth 403');
    r.ok(authFailure.status === 'auth-error' && authFailure.scope === 'auth' && authFailure.httpStatus === 403,
      'bootstrap auth 403 outranks successful core 2xx responses');

    // Once /api/auth itself recovers, a newer core failure must replace the old
    // auth error instead of being hidden by auth scope priority.
    mode = 'auth-recovered-core-500';
    await page.click('.connection-screen [data-action="retry-connection"]');
    await page.waitForFunction(() => window.appState?.connection?.httpStatus === 500);
    const postAuthCoreFailure = await connectionState();
    r.ok(postAuthCoreFailure.status === 'server-error' && postAuthCoreFailure.scope === 'core',
      'core failure after successful auth Retry replaces the recovered auth error');

    // A syntactically valid but schema-invalid auth 2xx is also a protocol
    // failure; bootstrap must inspect ok/schema rather than treating it as auth.
    mode = 'auth-malformed';
    authCoreProjects = 0;
    await goto('bootstrap-auth-schema');
    await page.waitForFunction(() => window.appState?.connection?.status === 'server-error');
    const malformedAuth = await connectionState();
    r.ok(authCoreProjects > 0, 'core APIs still completed after malformed auth 2xx');
    r.ok(malformedAuth.status === 'server-error' && malformedAuth.scope === 'auth',
      'bootstrap rejects malformed auth 2xx in the central connection state');

    // Hold an old-project poll after it has already selected switch-old. A user
    // navigation to switch-new must abort/invalidate that snapshot before loading
    // the new tasks, and releasing the old response must never reset the view.
    mode = 'pass';
    await goto('project-switch-race');
    await page.waitForFunction(() => window.appState?.connection?.status === 'ready');
    await page.click('[data-project="switch-old"]');
    await page.waitForFunction(() => window.appState?.viewedProject === 'switch-old'
      && window.appState?.tasks?.some((task) => task.title === 'Old project task')); 

    mode = 'hold-old-poll';
    oldPollStarted = new Promise((resolve) => { oldPollStartedResolve = resolve; });
    await oldPollStarted;
    await page.click('[data-project="switch-new"]');
    await page.waitForFunction(() => window.appState?.viewedProject === 'switch-new'
      && window.appState?.tasks?.some((task) => task.title === 'New project task')); 
    releaseOldPoll();
    await new Promise((resolve) => setTimeout(resolve, 500));

    const projectAfterRace = await page.evaluate(() => ({
      viewedProject: window.appState.viewedProject,
      taskTitles: window.appState.tasks.map((task) => task.title),
    }));
    r.ok(oldPollRequestFailed, 'project switch aborts the in-flight old-project poll request');
    r.ok(projectAfterRace.viewedProject === 'switch-new', 'late old poll cannot reset viewedProject');
    r.ok(projectAfterRace.taskTitles.includes('New project task')
      && !projectAfterRace.taskTitles.includes('Old project task'),
    'late old poll cannot overwrite the new project task snapshot');
  }, { port, viewport: { width: 1400, height: 900 } });

  if (res?.skipped) r.skip(res.reason);
  r.done();
}

main().catch((error) => { console.error(error); process.exit(1); });
