// T-499 F1 — the framed single-surface shell. Rendered by App.jsx instead of
// the standalone chrome (Header, Sidebar, TabBar, ViewShell, DetailPanel) only
// when embed mode is active.

import { useEffect } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { useDashboard } from '../context/DashboardContext.jsx';
import Sidebar from '../components/Sidebar.jsx';
import ViewShell from '../components/ViewShell.jsx';
import EmbedSpecify from './EmbedSpecify.jsx';
import { surfaceTab } from './embedMode.mjs';
import { getState } from '../state/appStore.mjs';
import { useEmbedState } from './useEmbedState.js';

function EmbedBridge({ embed }) {
  const { dispatch } = useAppState();
  const { viewProject } = useDashboard();

  // `ready` once the surface is mounted (the shell only mounts after the first
  // snapshot, so the host's ready-timeout also covers a dashboard that cannot
  // load inside the frame).
  useEffect(() => { embed.sendReady(); }, [embed]);

  // DetailPanel is not rendered in embed mode: task cards and other callers of
  // window.openTaskDetail open the task in the host's native board instead.
  useEffect(() => {
    const handler = (id) => embed.openTask(id);
    if (Array.isArray(window._detailQueue)) window._detailQueue.length = 0;
    window.openTaskDetail = handler;
    return () => {
      if (window.openTaskDetail === handler) delete window.openTaskDetail;
    };
  }, [embed]);

  // host -> frame `context`: switch surface / project / file without a reload.
  useEffect(() => embed.onHostMessage(async (msg) => {
    embed.setSurface(msg.surface);
    const state = getState();
    const known = (state.projects || []).some((p) => p?.name === msg.project);
    if (msg.project && known && msg.project !== state.viewedProject) {
      await viewProject(msg.project);
    }
    const patch = {};
    const tab = surfaceTab(msg.surface);
    if (tab && getState().currentTab !== tab) patch.currentTab = tab;
    if (msg.surface === 'files' && msg.file) {
      patch.pendingSpecFile = msg.file;
      patch.pendingSpecTaskId = null;
      patch.pendingSpecBackTab = null;
    }
    if (Object.keys(patch).length > 0) dispatch(patch);
  }), [embed, dispatch, viewProject]);

  return null;
}

export default function EmbedShell({ embed }) {
  const { surface } = useEmbedState(embed);
  return (
    <>
      <EmbedBridge embed={embed} />
      {surface === 'projects' && <Sidebar />}
      {surface === 'specify' && <EmbedSpecify embed={embed} />}
      {(surface === 'ideas' || surface === 'files') && <ViewShell />}
    </>
  );
}
