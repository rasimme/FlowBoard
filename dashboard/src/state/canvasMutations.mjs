// Canvas API mutations (T-340-3) — fetch wrappers around the unchanged
// canvas endpoints (ADR-0014), with the exact optimistic-update ordering of
// the vanilla canvas: create is server-first (the note id comes from the
// server), text/color/size/position update memory first and persist silently.

function toast(msg, type) {
  if (window.showToast) window.showToast(msg, type);
}

async function api(path, opts = {}) {
  const res = await fetch(`/api${path}`, {
    method: opts.method || 'GET',
    headers: { 'Content-Type': 'application/json' },
    body: opts.body ? JSON.stringify(opts.body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok && data.error === undefined) data.error = `HTTP ${res.status}`;
  return data;
}

/** Server-first create (vanilla createNoteAt). Returns the created note or null. */
export async function createNoteAt(project, dispatch, x, y) {
  if (!project) return null;
  try {
    const res = await api(`/projects/${project}/canvas/notes`, {
      method: 'POST',
      body: { text: '', x: Math.round(x), y: Math.round(y), color: 'grey' },
    });
    if (res.ok && res.note) {
      dispatch({ type: 'note-created', note: res.note });
      return res.note;
    }
    return null;
  } catch {
    toast('Failed to create note', 'error');
    return null;
  }
}

/** Optimistic text save; persistence failure is silent (vanilla saveNoteText). */
export async function saveNoteText(project, dispatch, id, text) {
  dispatch({ type: 'editing', id: null });
  dispatch({ type: 'note-patch', id, patch: { text } });
  if (!project) return;
  try {
    await api(`/projects/${project}/canvas/notes/${id}`, { method: 'PUT', body: { text } });
  } catch { /* silent — data is in memory */ }
}

/** Immediate position persist after drag end (vanilla saveNotePosition). */
export async function saveNotePosition(project, note) {
  if (!project || !note) return;
  try {
    await api(`/projects/${project}/canvas/notes/${note.id}`, {
      method: 'PUT', body: { x: Math.round(note.x), y: Math.round(note.y) },
    });
  } catch {
    toast('Position save failed — refresh may revert', 'warn');
  }
}

export async function deleteNote(project, dispatch, id) {
  if (!project) return false;
  try {
    const res = await api(`/projects/${project}/canvas/notes/${id}`, { method: 'DELETE' });
    if (res.ok) {
      dispatch({ type: 'note-deleted', id });
      return true;
    }
    return false;
  } catch {
    toast('Failed to delete note', 'error');
    return false;
  }
}

export async function setNoteColor(project, dispatch, id, color) {
  dispatch({ type: 'note-patch', id, patch: { color } });
  if (!project) return;
  try {
    await api(`/projects/${project}/canvas/notes/${id}`, { method: 'PUT', body: { color } });
  } catch { /* silent */ }
}

export async function setNoteSize(project, dispatch, id, size) {
  dispatch({ type: 'note-patch', id, patch: { size } });
  if (!project) return;
  try {
    await api(`/projects/${project}/canvas/notes/${id}`, { method: 'PUT', body: { size } });
  } catch { /* silent */ }
}

/** Create one note from a template (used by duplicate/paste). */
async function createNoteFrom(project, dispatch, body) {
  const res = await api(`/projects/${project}/canvas/notes`, { method: 'POST', body });
  if (res.ok && res.note) {
    dispatch({ type: 'note-created', note: res.note });
    return res.note.id;
  }
  return null;
}

/** Duplicate the given notes +40/+40 (vanilla duplicateSelected). Returns new ids. */
export async function duplicateNotes(project, dispatch, notes) {
  if (!project) return [];
  const newIds = [];
  for (const note of notes) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const id = await createNoteFrom(project, dispatch, {
        text: note.text || '',
        x: Math.round(note.x + 40),
        y: Math.round(note.y + 40),
        color: note.color || 'grey',
        size: note.size || 'small',
      });
      if (id) newIds.push(id);
    } catch { /* vanilla: per-note failures are silent */ }
  }
  if (newIds.length > 0) dispatch({ type: 'selection', ids: newIds });
  return newIds;
}

/** Paste clipboard items centered at (cx, cy) (vanilla pasteFromClipboard). */
export async function pasteNotes(project, dispatch, clipboard, cx, cy) {
  if (!project || clipboard.length === 0) return [];
  const newIds = [];
  for (const item of clipboard) {
    try {
      // eslint-disable-next-line no-await-in-loop
      const id = await createNoteFrom(project, dispatch, {
        text: item.text,
        x: Math.round(cx + item.offsetX),
        y: Math.round(cy + item.offsetY),
        color: item.color,
        size: item.size,
      });
      if (id) newIds.push(id);
    } catch { /* silent */ }
  }
  if (newIds.length > 0) dispatch({ type: 'selection', ids: newIds });
  return newIds;
}

/**
 * Persist a dragged connection (vanilla saveConnection): the server dedupes
 * A→B/B→A (`duplicate: true` → no-op) and may answer `updated: true` when an
 * existing edge got new ports.
 */
export async function saveConnection(project, dispatch, fromId, toId, fromPort, toPort) {
  if (!project) return;
  try {
    const res = await api(`/projects/${project}/canvas/connections`, {
      method: 'POST',
      body: { from: fromId, to: toId, fromPort: fromPort || null, toPort: toPort || null },
    });
    if (res.ok && res.updated) {
      dispatch({ type: 'connection-ports', from: fromId, to: toId, fromPort, toPort });
    } else if (res.ok && !res.duplicate) {
      dispatch({
        type: 'connection-added',
        connection: { from: fromId, to: toId, fromPort: fromPort || null, toPort: toPort || null },
      });
    }
  } catch {
    toast('Failed to save connection', 'error');
  }
}

export async function deleteConnection(project, dispatch, from, to) {
  if (!project) return;
  try {
    await api(`/projects/${project}/canvas/connections`, {
      method: 'DELETE', body: { from, to },
    });
    dispatch({ type: 'connection-deleted', from, to });
  } catch {
    toast('Failed to delete connection', 'error');
  }
}

/**
 * Promote selected notes to tasks via a Specify session (vanilla
 * sendPromote): empty notes are filtered, only intra-selection connections
 * travel, a duplicate active session (409) reopens the existing stepper.
 * `showStepper(sessionId)` opens the SpecifyStepper (SpecifyContext.show).
 */
export async function sendPromote(project, notes, connections, noteIds, mode, showStepper) {
  if (!project) return;

  const selected = noteIds
    .map(id => notes.find(n => n.id === id))
    .filter(n => n && n.text?.trim());
  if (selected.length === 0) {
    toast('No notes with text to promote', 'warn');
    return;
  }

  const idSet = new Set(noteIds);
  const conns = connections.filter(c => idSet.has(c.from) && idSet.has(c.to));

  try {
    const res = await api(`/projects/${project}/canvas/promote`, {
      method: 'POST',
      body: {
        notes: selected.map(n => ({ id: n.id, text: n.text, color: n.color || 'grey' })),
        connections: conns.map(c => ({ from: c.from, to: c.to })),
        mode,
      },
    });
    if (!res.ok) {
      if (res.error?.includes('active Specify session')) {
        const match = res.error.match(/(specify-[\w-]+)/);
        if (match?.[1] && showStepper) {
          showStepper(match[1]);
          return;
        }
      }
      toast(res.error || 'Promote failed', 'error');
      return;
    }
    window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success');
    if (!showStepper) {
      toast('Specify stepper not available', 'error');
      return;
    }
    showStepper(res.sessionId);
  } catch (err) {
    toast('Promote failed: ' + (err.message || 'Unknown error'), 'error');
  }
}

/**
 * Notes created via API land at (0,0); scatter them around the visible
 * center so they don't stack (vanilla repositionZeroNote). Persists silently.
 */
export function repositionZeroNote(project, dispatch, note, viewportW, viewportH, pan, scale) {
  const cx = (viewportW / 2 - pan.x) / scale;
  const cy = (viewportH / 2 - pan.y) / scale;
  const x = cx + (Math.random() - 0.5) * 200;
  const y = cy + (Math.random() - 0.5) * 100;
  dispatch({ type: 'note-patch', id: note.id, patch: { x, y } });
  if (!project) return;
  api(`/projects/${project}/canvas/notes/${note.id}`, {
    method: 'PUT', body: { x: Math.round(x), y: Math.round(y) },
  }).catch(() => {});
}
