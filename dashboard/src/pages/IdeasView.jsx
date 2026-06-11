import { useState, useEffect, useCallback, useRef } from 'react';
import { useAppState } from '../context/AppStateContext.jsx';
import { Button, Modal, Textarea, Spinner } from '../components/index.js';
import { Plus, Trash2, Pencil, X, Check, Lightbulb } from 'lucide-react';

const NOTE_COLORS = ['grey', 'yellow', 'blue', 'green', 'red', 'teal'];
const COLOR_MAP = {
  grey: { bg: 'bg-border-strong', ring: 'ring-border-strong', label: 'Grey' },
  yellow: { bg: 'bg-warn', ring: 'ring-warn', label: 'Yellow' },
  blue: { bg: 'bg-info', ring: 'ring-info', label: 'Blue' },
  green: { bg: 'bg-ok', ring: 'ring-ok', label: 'Green' },
  red: { bg: 'bg-danger', ring: 'ring-danger', label: 'Red' },
  teal: { bg: 'bg-accent-2', ring: 'ring-accent-2', label: 'Teal' },
};

function relativeTime(ts) {
  if (!ts) return '';
  const diff = Date.now() - new Date(ts).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days}d ago`;
  return `${Math.floor(days / 30)}mo ago`;
}

function ColorPicker({ value, onChange }) {
  return (
    <div className="flex gap-2 mt-2">
      {NOTE_COLORS.map(c => (
        <button
          key={c}
          type="button"
          className={[
            'w-7 h-7 rounded-full border-2 transition-all duration-fast cursor-pointer',
            COLOR_MAP[c].bg,
            value === c ? 'border-text-strong scale-110' : 'border-transparent hover:border-border-strong',
          ].join(' ')}
          onClick={() => onChange(c)}
          title={COLOR_MAP[c].label}
        />
      ))}
    </div>
  );
}

function NoteCard({ note, onEdit, onDelete }) {
  const [expanded, setExpanded] = useState(false);
  const color = COLOR_MAP[note.color] || COLOR_MAP.grey;
  const text = note.text || '';
  const isLong = text.length > 140;

  return (
    <div className="bg-bg-elevated rounded-lg border border-border p-3 flex flex-col gap-2 transition-colors hover:border-border-strong">
      <div className="flex items-start gap-2">
        <span className={`w-2.5 h-2.5 rounded-full shrink-0 mt-1 ${color.bg}`} />
        <div className="flex-1 min-w-0">
          <div
            className={`text-sm text-text leading-snug whitespace-pre-wrap break-words ${!expanded && isLong ? 'line-clamp-3' : ''}`}
            onClick={isLong ? () => setExpanded(!expanded) : undefined}
            style={isLong ? { cursor: 'pointer' } : undefined}
          >
            {text || <span className="text-muted italic">Empty note</span>}
          </div>
          {isLong && !expanded && (
            <button
              type="button"
              className="text-[11px] text-accent mt-0.5 bg-transparent border-0 p-0 cursor-pointer hover:underline"
              onClick={() => setExpanded(true)}
            >
              Show more
            </button>
          )}
        </div>
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            className="p-1 rounded text-muted hover:text-text hover:bg-bg-hover transition-colors cursor-pointer bg-transparent border-0"
            onClick={() => onEdit(note)}
            title="Edit"
          >
            <Pencil size={14} />
          </button>
          <button
            type="button"
            className="p-1 rounded text-muted hover:text-danger hover:bg-danger-subtle transition-colors cursor-pointer bg-transparent border-0"
            onClick={() => onDelete(note)}
            title="Delete"
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>
      {note.createdAt && (
        <span className="text-[10px] text-muted pl-[18px]">{relativeTime(note.createdAt)}</span>
      )}
    </div>
  );
}

export default function IdeasView() {
  const { state } = useAppState();
  const viewedProject = state?.viewedProject;

  const [notes, setNotes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  // Create modal
  const [showCreate, setShowCreate] = useState(false);
  // overview quick action "New Note" — consumed like window._scrollToTaskId
  useEffect(() => {
    if (window._pendingNewNote) {
      delete window._pendingNewNote;
      setShowCreate(true);
    }
  });
  const [newText, setNewText] = useState('');
  const [newColor, setNewColor] = useState('yellow');
  const [saving, setSaving] = useState(false);

  // Edit state (inline)
  const [editingId, setEditingId] = useState(null);
  const [editText, setEditText] = useState('');
  const [editColor, setEditColor] = useState('grey');
  const editRef = useRef(null);

  // Delete confirmation
  const [deleteNote, setDeleteNote] = useState(null);
  const [deleting, setDeleting] = useState(false);

  // Search
  const [search, setSearch] = useState('');

  // Fetch notes
  const fetchNotes = useCallback(async () => {
    if (!viewedProject) return;
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(`/api/projects/${viewedProject}/notes`);
      if (!res.ok) throw new Error('Failed to load notes');
      const data = await res.json();
      setNotes(data);
    } catch (e) {
      console.warn('IdeasView: fetch notes failed', e);
      setError(e.message);
    } finally {
      setLoading(false);
    }
  }, [viewedProject]);

  useEffect(() => {
    fetchNotes();
  }, [fetchNotes]);

  // Refresh on appState changes (polling sync)
  useEffect(() => {
    if (state?.currentTab === 'ideas' && viewedProject) {
      fetchNotes();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state?.version]);

  // Create note
  const handleCreate = async () => {
    if (!newText.trim() || !viewedProject) return;
    setSaving(true);
    try {
      const res = await fetch(`/api/projects/${viewedProject}/notes`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: newText.trim(), color: newColor }),
      });
      if (!res.ok) throw new Error('Failed to create note');
      setShowCreate(false);
      setNewText('');
      setNewColor('yellow');
      await fetchNotes();
    } catch (e) {
      console.warn('IdeasView: create failed', e);
    } finally {
      setSaving(false);
    }
  };

  // Start editing
  const startEdit = (note) => {
    setEditingId(note.id);
    setEditText(note.text || '');
    setEditColor(note.color || 'grey');
    setTimeout(() => editRef.current?.focus(), 0);
  };

  // Save edit
  const saveEdit = async () => {
    if (!editingId || !viewedProject) return;
    try {
      const res = await fetch(`/api/projects/${viewedProject}/notes/${editingId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: editText.trim(), color: editColor }),
      });
      if (!res.ok) throw new Error('Failed to update note');
      setEditingId(null);
      await fetchNotes();
    } catch (e) {
      console.warn('IdeasView: edit failed', e);
    }
  };

  // Delete note
  const confirmDelete = async () => {
    if (!deleteNote || !viewedProject) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/projects/${viewedProject}/notes/${deleteNote.id}`, {
        method: 'DELETE',
      });
      if (!res.ok) throw new Error('Failed to delete note');
      setDeleteNote(null);
      await fetchNotes();
    } catch (e) {
      console.warn('IdeasView: delete failed', e);
    } finally {
      setDeleting(false);
    }
  };

  // Filter notes
  const filtered = search.trim()
    ? notes.filter(n => (n.text || '').toLowerCase().includes(search.toLowerCase()))
    : notes;

  if (!viewedProject) {
    return (
      <div className="flex items-center justify-center h-full text-muted text-sm" data-react-ideas>
        Select a project to view ideas
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full" data-react-ideas>
      {/* Header */}
      <div className="flex items-center justify-between px-4 pt-3 pb-2 shrink-0">
        <div className="flex items-center gap-2">
          <Lightbulb size={18} className="text-accent" />
          <h2 className="text-base font-semibold text-text-strong m-0">Ideas</h2>
          <span className="text-xs text-muted font-mono">{notes.length}</span>
        </div>
        <Button size="sm" onClick={() => setShowCreate(true)}>
          <Plus size={14} /> New
        </Button>
      </div>

      {/* Search */}
      {notes.length > 0 && (
        <div className="px-4 pb-2">
          <input
            type="text"
            placeholder="Search ideas…"
            value={search}
            onChange={e => setSearch(e.target.value)}
            className="w-full px-3 py-1.5 text-sm rounded-lg bg-bg-elevated text-text border border-border placeholder:text-muted outline-none focus:border-accent-subtle focus:shadow-focus-accent transition-colors duration-fast"
          />
        </div>
      )}

      {/* Content */}
      <div className="flex-1 overflow-y-auto px-4 pb-4 min-h-0">
        {loading && notes.length === 0 ? (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" />
          </div>
        ) : error ? (
          <div className="text-danger text-sm text-center py-8">{error}</div>
        ) : filtered.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-16 text-muted">
            <Lightbulb size={32} className="mb-3 opacity-30" />
            <p className="text-sm m-0">
              {search ? 'No matching ideas' : 'No ideas yet — add one!'}
            </p>
          </div>
        ) : (
          <div className="grid gap-2 grid-cols-1 sm:grid-cols-2 lg:grid-cols-3">
            {filtered.map(note => (
              editingId === note.id ? (
                <div key={note.id} className="bg-bg-elevated rounded-lg border border-accent p-3 flex flex-col gap-2">
                  <Textarea
                    ref={editRef}
                    rows={4}
                    value={editText}
                    onChange={e => setEditText(e.target.value)}
                    onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) saveEdit(); }}
                  />
                  <ColorPicker value={editColor} onChange={setEditColor} />
                  <div className="flex justify-end gap-1.5 mt-1">
                    <Button size="sm" variant="ghost" onClick={() => setEditingId(null)}>
                      <X size={14} /> Cancel
                    </Button>
                    <Button size="sm" onClick={saveEdit}>
                      <Check size={14} /> Save
                    </Button>
                  </div>
                </div>
              ) : (
                <NoteCard
                  key={note.id}
                  note={note}
                  onEdit={startEdit}
                  onDelete={setDeleteNote}
                />
              )
            ))}
          </div>
        )}
      </div>

      {/* Create Modal */}
      <Modal
        open={showCreate}
        onClose={() => setShowCreate(false)}
        title="New Idea"
        actions={
          <>
            <Button variant="ghost" onClick={() => setShowCreate(false)}>Cancel</Button>
            <Button onClick={handleCreate} disabled={saving || !newText.trim()}>
              {saving ? <Spinner size="sm" /> : 'Create'}
            </Button>
          </>
        }
      >
        <Textarea
          rows={4}
          placeholder="What's on your mind?"
          value={newText}
          onChange={e => setNewText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && e.metaKey) handleCreate(); }}
          autoFocus
        />
        <ColorPicker value={newColor} onChange={setNewColor} />
      </Modal>

      {/* Delete Confirmation */}
      <Modal
        open={!!deleteNote}
        onClose={() => setDeleteNote(null)}
        title="Delete Idea"
        actions={
          <>
            <Button variant="ghost" onClick={() => setDeleteNote(null)}>Cancel</Button>
            <Button variant="danger" onClick={confirmDelete} disabled={deleting}>
              {deleting ? <Spinner size="sm" /> : 'Delete'}
            </Button>
          </>
        }
      >
        <p className="m-0">Are you sure you want to delete this idea? This cannot be undone.</p>
      </Modal>
    </div>
  );
}
