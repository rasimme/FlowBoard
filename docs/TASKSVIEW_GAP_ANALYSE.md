# TasksView Gap Analysis — main vs dev

**Date:** 2026-04-15
**Scope:** Legacy kanban (`main`) vs React rewrite (`dev`)
**Files analyzed:**
- main: `dashboard/js/kanban.js` (887 lines), `dashboard/styles/dashboard.css` (kanban section ~465 lines)
- dev: `dashboard/src/pages/TasksView.jsx` (673 lines), `dashboard/tailwind.config.js`, `dashboard/src/components/Badge.jsx`

---

## 1. Feature Comparison Table

| # | Feature | main (kanban.js) | dev (TasksView.jsx) | Status | Priority |
|---|---------|-----------------|---------------------|--------|----------|
| 1 | Drag & drop between columns | Full implementation with visual feedback | Not implemented | ❌ Missing | P0 |
| 2 | Inline task title editing | Click title → input, Enter/Esc/blur | Not implemented (opens DetailPanel) | ❌ Missing | P0 |
| 3 | Inline subtask title editing | Click title → auto-grow textarea | Not implemented (opens DetailPanel) | ❌ Missing | P0 |
| 4 | Subtask creation (inline form) | Add-subtask button + inline form with tree decorations | Not implemented | ❌ Missing | P0 |
| 5 | Spec file badges on cards | View/create spec badges on task + subtask cards | Not implemented | ❌ Missing | P0 |
| 6 | Delete task modes (subtask handling) | 3 modes: default, all, keep-children | Basic delete only (no subtask handling) | ⚠️ Partial | P0 |
| 7 | Optimistic updates | Priority + drag-drop status changes instant | All changes wait for poll refresh (~5s) | ❌ Missing | P1 |
| 8 | New card animation | `rise` keyframe (350ms fade+slide) | No animation | ❌ Missing | P1 |
| 9 | Delete card animation | `shrink` keyframe (250ms scale+fade) | No animation | ❌ Missing | P1 |
| 10 | Priority popover (color pills) | Horizontal row of color-coded pills, popIn animation | Plain text vertical list, no animation | ⚠️ Different | P1 |
| 11 | Subtask status popover | Interactive status dots with colored options | Non-interactive dot (click opens DetailPanel) | ❌ Missing | P1 |
| 12 | Priority selector in add-task form | Clickable color-coded pills | Plain `<select>` dropdown | ⚠️ Different | P1 |
| 13 | Column layout fills width | CSS grid `repeat(4, 1fr)` | Flex with fixed min/max widths | ⚠️ Different | P1 |
| 14 | Parent status propagation on subtask change | Server returns `parentUpdated`, local sync | Not handled | ❌ Missing | P1 |
| 15 | Tab bar sort control | Renders in shared tabBarRight area | Inline within TasksView | ⚠️ Different | P1 |
| 16 | Card shadow + inset highlight | `shadow-sm` + `inset 0 1px card-highlight` | None | ❌ Missing | P2 |
| 17 | Tree-line decoration system | Full trunk + branch + dot pseudo-elements | Simple left border indent | ⚠️ Different | P2 |
| 18 | Popover animation (popIn) | 120ms opacity + translateY | No animation | ❌ Missing | P2 |
| 19 | Mobile scroll-snap | `scroll-snap-type: x mandatory` at 900px | `overflow-x-auto` only, no snap | ❌ Missing | P2 |
| 20 | Mobile touch targets | `min-height: 44px` cards at 600px | No mobile adjustments | ❌ Missing | P2 |
| 21 | Card cursor: grab | `cursor: grab` (drag affordance) | `cursor-pointer` | ⚠️ Different | P2 |
| 22 | Card hover effect | Border strengthens + shadow grows | Background color change only | ⚠️ Different | P2 |
| 23 | Status columns | 4: open, in-progress, review, done | 5: adds backlog | ⚠️ Different | — |
| 24 | Archived tasks toggle | Not supported | New feature: toggle + dimmed cards | ✅ New | — |
| 25 | Backlog column | Not supported | New column with add-task form | ✅ New | — |
| 26 | useHaptic hook | Inline `_h()` / `_hn()` calls | Dedicated hook with full type coverage | ✅ Improved | — |

---

## 2. P0 Gaps — Broken Workflow

### 2.1 Drag & Drop (Complete Absence)

**What main does:**

Cards are `draggable=true` with full event handlers:

- `onDragStart` (`kanban.js:765`): stores `draggedId`, adds `.dragging` class (opacity 0.4)
- `onDragEnd` (`kanban.js:771`): removes all `.drag-over` classes, clears `draggedId`
- `onDragOver` (`kanban.js:777`): `e.preventDefault()`, adds `.drag-over` to target column
- `onDragLeave` (`kanban.js:783`): removes `.drag-over` if cursor exits column bounds
- `onDrop` (`kanban.js:789-818`): gets target column status, optimistically updates `task.status`, calls `updateBoard()` immediately, then fires PUT API. On failure: reverts status, shows error toast, haptic error, re-renders board.

Visual feedback CSS (`dashboard.css`):
```css
.task-card.dragging { opacity: 0.4; }                              /* :274 */
.column.drag-over { border-color: var(--accent);
                    background: rgba(255, 92, 92, .05); }          /* :244 */
```

Drag events are delegated at the container level (`kanban.js:855-865`):
```js
container.addEventListener('dragover', e => { ... onDragOver(e); });
container.addEventListener('dragleave', e => { ... onDragLeave(e); });
container.addEventListener('drop', e => { ... window._onDrop(e); });
```

**What dev does:** Nothing. No `draggable` attribute, no drag handlers, no drop zones. Moving a task between columns requires: click card → DetailPanel opens → click status label → select new status from popover → wait for poll refresh (~5s). This is 4 interactions + wait vs. 1 drag gesture.

---

### 2.2 Inline Task Title Editing

**What main does:**

Click task title (`data-action="edit-task"`) → `startEdit(id)` (`kanban.js:446`):
1. Sets `kanbanState.editingTaskId = id`
2. Re-renders card HTML (title element becomes `<input class="task-title-input">`)
3. Auto-focuses + selects text
4. Binds `keydown`: Enter → blur (saves), Escape → cancel (restores original)
5. Binds `blur` → `saveTitle()` (`kanban.js:508`): PUT `/projects/{project}/tasks/{id}` with `{ title: newTitle }`

For subtask titles, uses `<textarea>` with auto-grow (`kanban.js:463-497`):
- `_autoGrowTextarea()` (`kanban.js:499`): sets `height = scrollHeight`
- Shift+Enter → newline, Enter → save, Escape → cancel
- `.subtask-card.editing` class hides action buttons during edit

CSS (`dashboard.css`):
```css
.task-title-input {
  font-size: 13px; font-weight: 500; color: var(--text);
  background: var(--bg-elevated); border: 1px solid var(--border-strong);
  border-radius: var(--radius-sm); padding: 4px 6px; width: 100%;
}                                                                   /* :282-287 */
.task-title-input:focus { border-color: var(--accent); }           /* :288 */
.subtask-card.editing .subtask-actions { display: none; }          /* :541 */
```

**What dev does:** Clicking a TaskCard calls `window.openTaskDetail(task.id)` (`TasksView.jsx:108`), opening the DetailPanel side panel. No `editingTaskId` state exists. No inline input/textarea rendering.

---

### 2.3 Subtask Creation (Inline Form)

**What main does:**

Each task card has a subtask-add icon button (`kanban.js:277`):
```html
<span class="subtask-add-btn" data-action="add-subtask" data-id="T-123"
      title="Add subtask">${ICON_SUBTASK}</span>
```

Clicking triggers `startAddSubtask(id)` (`kanban.js:379`):
1. Sets `kanbanState.addingSubtaskParentId = id`
2. Auto-expands parent (adds to `expandedParents` Set)
3. `updateBoard()` renders an inline form inside the subtask container (`kanban.js:152-187`)

Form structure:
```html
<div class="add-subtask-form">
  <div class="tree-dot-form"></div>  <!-- visual connector -->
  <input class="subtask-input" placeholder="Subtask title...">
  <div class="form-actions">
    <button data-action="submit-subtask">Add</button>
    <button data-action="cancel-subtask">Cancel</button>
  </div>
</div>
```

Tree-line decorations on the form match subtask cards exactly (`dashboard.css:326-356`):
- `::before` pseudo: vertical trunk line
- `::after` pseudo: horizontal branch
- `.tree-dot-form`: circular connector dot

`submitSubtask()` (`kanban.js:398`): POST `/projects/{project}/tasks` with `{ title, parentId }`. Updates parent's `subtaskIds` array and `progress` counters in local state.

**What dev does:** No subtask-add button on cards. No `addingSubtaskParentId` state. No inline form. Subtask creation is only possible through external mechanisms (API/DetailPanel).

---

### 2.4 Spec File Badges on Cards

**What main does:**

Every task card renders a spec badge in the meta-actions area (`kanban.js:273-276`):

Existing spec (clickable, opens file):
```html
<span class="spec-badge" data-action="open-spec"
      data-file="specs/T-123.md" title="Open spec file">
  ${ICON_SPEC}  <!-- file icon SVG -->
</span>
```

Missing spec (dimmed, creates on click):
```html
<span class="spec-badge spec-badge-add" data-action="create-spec"
      data-id="T-123" title="Create spec file">
  ${ICON_SPEC_ADD}  <!-- file-plus icon SVG -->
</span>
```

Subtask cards also have smaller spec badges (`kanban.js:323-325`, class `spec-badge-sm`).

CSS visibility pattern (`dashboard.css:292-316`):
- `.spec-badge`: always visible, accent colored bg+border
- `.spec-badge-add`: `opacity: 0` by default
- `.task-card:hover .spec-badge-add`: `opacity: 0.5`
- `.task-card:hover .spec-badge-add:hover`: `opacity: 1`
- Same pattern for subtask cards (`dashboard.css:596-600`)

Actions:
- `open-spec` → `window._openSpec(file, id)` → switches to files tab
- `create-spec` → `window._createSpec(id)` → POST `/projects/{project}/specs/{taskId}`, updates `task.specFile`, switches to files tab

**What dev does:** No spec badges rendered on TaskCard or SubtaskCard. No ICON_SPEC imports. Spec file interaction only available through DetailPanel.

---

### 2.5 Delete Task Modes (Subtask Handling)

**What main does:**

`startDelete()` (`kanban.js:660-695`) builds a modal dynamically based on task state:

**Has subtasks + spec:**
```html
<label class="modal-checkbox">
  <input type="checkbox" id="delSubtasks" checked>
  <span class="check-box">${checkSvg}</span> Delete N subtask(s)
</label>
<label class="modal-checkbox">
  <input type="checkbox" id="delSpec" checked>
  <span class="check-box">${checkSvg}</span> Delete spec file
</label>
```

`confirmDelete()` (`kanban.js:697-749`) handles 3 modes:
- **Default** (no subtasks): `DELETE /projects/{project}/tasks/{id}`
- **`mode=all`**: `DELETE ...?mode=all` — removes task + all subtasks from `state.tasks`
- **`mode=keep-children`**: `DELETE ...?mode=keep-children` — removes task, sets `t.parentId = null` on children (promotes to top-level)

After deletion of a subtask, also handles parent cleanup (`kanban.js:731-740`):
- Removes subtask ID from `parent.subtaskIds`
- If no subtasks left: sets `subtaskIds = undefined`, removes from `expandedParents` (auto-demotion)

CSS for custom checkboxes (`dashboard.css:684-692`): styled `.check-box` with accent background on `:checked`, SVG check icon fades in.

**What dev does:**

`DeleteTaskModal` (`TasksView.jsx:264-317`) only offers one checkbox:
```jsx
<label>
  <input type="checkbox" checked={deleteSpec}
         onChange={(e) => setDeleteSpec(e.target.checked)} />
  Also delete spec file
</label>
```

API call: `DELETE /api/projects/${project}/tasks/${task.id}${deleteSpec ? '?deleteSpec=true' : ''}`. No `mode` parameter. No subtask count awareness. No parent cleanup logic.

---

## 3. P1 Gaps — Important Regressions

### 3.1 Optimistic Updates

**main:** Two optimistic update patterns:

1. **Priority** (`kanban.js:631-658`): Immediately updates DOM pill class + text + `task.priority`. API call follows. On failure: reverts `task.priority` + pill visuals, shows error toast + haptic.

2. **Drag-drop status** (`kanban.js:799-804`): Immediately sets `task.status`, updates `task.completed` date, calls `updateBoard()` for instant visual feedback. API call follows. On failure: reverts status, re-renders, error toast + haptic.

**dev:** `handleTaskUpdated` (`TasksView.jsx:583-598`):
```js
// Optimistic update would go here, but for now rely on polling refresh
const res = await fetch(url, { method: 'PUT', ... });
```
Comment on line 584 confirms this is a known gap. The fingerprint poll runs every 500ms (`AppStateContext.jsx:28`) but only detects changes to `window.appState`, which is updated by the 5s server poll in `app.js`. Result: **up to 5.5s delay** before UI reflects user's action.

---

### 3.2 New Card Animation

**main:** `kanbanState.newCardIds` Set (`kanban.js:16`) tracks newly created task IDs. `createCardElement()` checks this and adds `.new-card` class. Cleared after 400ms (`kanban.js:224`).

```css
.task-card.new-card { animation: rise var(--duration-slow) var(--ease-out) both; }  /* :272 */
@keyframes rise {
  from { opacity: 0; transform: translateY(8px); }
  to   { opacity: 1; transform: translateY(0); }
}                                                                                    /* :694 */
```

**dev:** `onTaskCreated` prop is passed as `() => {}` (no-op) at `TasksView.jsx:665`. No `newCardIds` tracking. No animation class. Cards appear silently on next poll refresh.

---

### 3.3 Delete Card Animation

**main:** Before API call, adds `.removing` class with 250ms await (`kanban.js:698-700`):
```js
if (card) card.classList.add('removing');
await new Promise(r => setTimeout(r, 250));
```

```css
.task-card.removing {
  animation: shrink 0.25s var(--ease-out) forwards;
}                                                                    /* :275 */
@keyframes shrink {
  to { opacity: 0; transform: scale(0.95) translateY(-4px);
       height: 0; padding: 0; margin: 0; border: 0; overflow: hidden; }
}                                                                    /* :695 */
```

**dev:** No animation. Card disappears on next poll refresh (up to 5s) or after `onTaskDeleted` removes it from state (but no visual transition).

---

### 3.4 Priority Popover Visual Mismatch

**main:** Horizontal row of **color-coded priority pills** (`kanban.js:532-566`):
- Renders 3 `<span class="priority-pill priority-{p}">` elements in a flex row
- Current priority at `opacity: 1`, others at `0.5` (hover → `1`)
- Positioned ABOVE the trigger pill with `transform: translate(-50%, -100%)`
- `popIn` animation: 120ms opacity+translateY (`dashboard.css:386`)
- Rendered at `document.body` level with `position: fixed` to avoid scroll-container clipping
- Closes on click outside OR window scroll

CSS (`dashboard.css:373-386`):
```css
.priority-popover {
  position: absolute; bottom: calc(100% + 6px);
  left: 50%; transform: translateX(-50%);
  display: flex; flex-direction: row; gap: 4px; padding: 6px;
  background: var(--card); border: 1px solid var(--border);
  border-radius: var(--radius-md);
  box-shadow: 0 12px 28px rgba(0,0,0,.35);
  animation: popIn var(--duration-fast) var(--ease-out);
}
```

**dev:** Generic `Popover` component (`TasksView.jsx:320-362`):
- Plain text buttons in a vertical list: `"High"`, `"Medium"`, `"Low"`
- No color coding per option
- Positioned BELOW trigger at `anchorRect.bottom + 4`
- No animation
- No scroll-close listener
- Can clip off viewport edges (no boundary detection)

---

### 3.5 Subtask Status Popover

**main:** Status dot on subtask cards is interactive (`kanban.js:327-328`):
```html
<span class="status-dot-wrap" data-action="toggle-status" data-id="..." data-status="...">
  <span class="status-dot status-dot-{status}"></span>
</span>
```

Click opens `toggleStatusPopover()` (`kanban.js:577-599`): 4 options (Open, In Progress, Review, Done) each with a colored status dot + label. `setSubtaskStatus()` (`kanban.js:602`) handles:
- Optimistic local status update + completed date logic
- PUT API call
- Checks `res.parentUpdated` and propagates parent status changes (`kanban.js:614-619`)

CSS (`dashboard.css:563-593`):
```css
.status-dot-wrap { width: 20px; height: 20px; cursor: pointer; }
.status-dot-wrap:hover { background: rgba(255,255,255,.08); }
.status-popover { /* similar styling to priority popover */ }
.status-option { display: flex; align-items: center; gap: 8px; }
```

**dev:** `SubtaskCard` (`TasksView.jsx:76-103`) renders a non-interactive colored dot:
```jsx
<span className={`w-1.5 h-1.5 rounded-full ${statusColors[task.status]}`} />
```
Clicking the entire subtask card opens DetailPanel. No status popover. No parent status propagation logic in `handleTaskUpdated`.

---

### 3.6 Add-Task Form Priority Selector

**main:** Three clickable pill buttons with color-coded selected state (`kanban.js:339-351`):
```html
<div class="priority-selector">
  <button class="priority-option" data-p="low">low</button>
  <button class="priority-option selected" data-p="medium">medium</button>
  <button class="priority-option" data-p="high">high</button>
</div>
```

CSS (`dashboard.css:629-641`):
```css
.priority-option.selected { color: var(--text-strong); }
.priority-option[data-p="high"].selected {
  color: var(--danger); border-color: #ef444459; background: var(--danger-subtle);
}
/* same pattern for medium (warn) and low (ok) */
```

**dev:** Plain `<select>` dropdown (`TasksView.jsx:448-452`):
```jsx
<select value={priority} onChange={(e) => setPriority(e.target.value)}>
  <option value="high">High</option>
  <option value="medium">Medium</option>
  <option value="low">Low</option>
</select>
```
No color coding. Uses browser-default select styling.

---

### 3.7 Column Layout Not Filling Width

**main:** `dashboard.css:235`:
```css
.kanban { display: grid; grid-template-columns: repeat(4, 1fr); gap: 12px; }
```
Columns always fill available width equally.

**dev:** `TasksView.jsx:651`:
```jsx
<div className="flex gap-3 px-3 pb-3 flex-1 overflow-x-auto min-h-0">
```
Column: `min-w-[260px] max-w-[320px] flex-1` (`TasksView.jsx:482`). On wide screens, 5 columns at max 320px = 1600px, leaving unused space. On narrow screens, columns scroll horizontally but aren't proportionally sized.

---

### 3.8 Parent Status Propagation on Subtask Change

**main:** `setSubtaskStatus()` (`kanban.js:602-627`):
```js
if (res.parentUpdated) {
  const parent = state.tasks.find(t => t.id === res.parentUpdated.id);
  if (parent) {
    parent.status = res.parentUpdated.status;
    if (res.parentUpdated.progress) parent.progress = res.parentUpdated.progress;
  }
}
```
When all subtasks are done, the server may update the parent task status. This response field is handled immediately in main.

**dev:** `handleTaskUpdated` (`TasksView.jsx:583-598`) does not check for `parentUpdated` in the API response. Parent status only updates on next 5s poll.

---

### 3.9 Tab Bar Sort Control Placement

**main:** `renderTabBarRight()` (`kanban.js:820-827`) renders the sort toggle button in `#tabBarRight`, which lives in the shared tab bar area.

**dev:** Sort control is rendered inline within TasksView (`TasksView.jsx:641-649`):
```jsx
<div className="flex items-center justify-end px-3 pt-2 pb-1 gap-2 shrink-0">
  <button onClick={handleToggleSort}>...Newest first / Oldest first...</button>
</div>
```
This takes up vertical space within the content area rather than using the tab bar.

---

### 3.10 Column Count Badge Styling

**main:** (`dashboard.css:255-258`):
```css
.column-count {
  background: var(--secondary); border-radius: var(--radius-full);
  padding: 2px 8px; font-size: 11px; font-weight: 600; color: var(--muted);
}
```

**dev:** (`TasksView.jsx:488`):
```jsx
<span className="text-[11px] text-muted bg-bg-elevated rounded-full px-2 py-0.5 font-mono">
```
Different background (`bg-elevated` vs `secondary`), adds `font-mono` which main doesn't use.

---

## 4. P2 Gaps — Cosmetic/Visual

### 4.1 Card Shadow + Inset Highlight

**main:** `dashboard.css:269`:
```css
box-shadow: var(--shadow-sm), inset 0 1px 0 var(--card-highlight);
```
Two-part shadow: external depth + top-edge highlight simulating glass/bevel.

**dev:** No explicit shadow on task cards. Only `border border-border` provides visual depth.

---

### 4.2 Card Border Radius Mismatch

**main:** `border-radius: var(--radius-md)` = 8px (`dashboard.css:266`)
**dev:** `rounded-lg` maps to `var(--radius-lg)` = 12px (`tailwind.config.js:65`)

Dev cards are noticeably rounder.

---

### 4.3 Card Cursor

**main:** `cursor: grab` (`dashboard.css:271`) — signals drag affordance.
**dev:** `cursor-pointer` (`TasksView.jsx:148`) — signals click, not drag.

---

### 4.4 Card Hover Effect

**main:** `dashboard.css:273`:
```css
.task-card:hover { border-color: var(--border-strong); box-shadow: var(--shadow-md); }
```
Border strengthens + shadow grows — depth increases on hover.

**dev:** `hover:bg-bg-hover` (`TasksView.jsx:148`) — background color change only.

---

### 4.5 Column Background + Padding

**main:** `background: var(--bg-accent)`, `padding: 12px` all around (`dashboard.css:238-239`).
**dev:** `bg-bg-surface`, no padding on column div; `p-2` (8px) on body (`TasksView.jsx:482,503`).

Column header in main: `margin-bottom: 12px`, title color `var(--text)` (white).
Column header in dev: `border-b border-border`, title color `text-secondary` (dimmer).

---

### 4.6 Tree-Line Decoration System

**main:** Full tree system with pseudo-elements (`dashboard.css:450-515`):

```
Parent Card
├── Subtask 1      ← vertical trunk (::before) + horizontal branch (::after) + dot (.tree-dot)
├── Subtask 2
└── Subtask 3      ← last-child: trunk stops at midpoint
```

- `.subtask-container`: `margin-left: 14px; padding-left: 22px`
- `.subtask-card::before`: vertical trunk (width 1.5px, `var(--tree-line)` #3f3f46)
- `.subtask-card:last-child::before`: `bottom: 50%` (stops at center)
- `.subtask-card::after`: horizontal branch (width 10px, height 1.5px)
- `.tree-dot`: 5px circle at junction point

**dev:** Simple border indent (`TasksView.jsx:242`):
```jsx
<div className="flex flex-col gap-1 ml-3 mt-1 pl-2 border-l-2 border-border/40">
```
No pseudo-elements, no dots, no horizontal branches. Just a 2px left border at 40% opacity.

---

### 4.7 Progress Bar Color Mismatch

**main:** Uses status colors (`dashboard.css:427-438`):
- Done: `var(--status-done)` = `#d04040` (red)
- Review: `var(--status-review)` = `#e07020` (orange)
- Active: `var(--status-in-progress)` = `#f0c000` (yellow)

**dev:** Uses semantic color classes (`TasksView.jsx:65-67`):
```jsx
<div className="bg-success" ... />   // done
<div className="bg-info" ... />      // review
<div className="bg-warning" ... />   // active
```

**BUG:** `bg-success` and `bg-warning` are NOT defined in `tailwind.config.js`. The config defines `ok` (not `success`) and `warn` (not `warning`). Only `bg-info` resolves correctly. The done and active segments render with no background color — effectively invisible.

Fix: change to `bg-ok`, `bg-warn`, or add `success`/`warning` aliases to tailwind config.

---

### 4.8 Progress Bar Height

**main:** `height: 4px` (`dashboard.css:421`)
**dev:** `h-1.5` = 6px (`TasksView.jsx:63`)

---

### 4.9 Popover Animation

**main:** `@keyframes popIn` (`dashboard.css:386`):
```css
from { opacity: 0; transform: translateX(-50%) translateY(4px); }
to   { opacity: 1; transform: translateX(-50%) translateY(0); }
```
Duration: `var(--duration-fast)` (~120ms). Applied to both priority and status popovers.

**dev:** No animation on Popover component. Appears instantly.

---

### 4.10 Delete Button Styling

**main:** Absolute-positioned, size 24x24, custom transition (`dashboard.css:388-397`):
```css
.delete-btn { opacity: 0; width: 24px; height: 24px; ... }
.task-card:hover .delete-btn { opacity: 1; }
.delete-btn:hover { color: var(--danger); background: var(--danger-subtle); }
```

**dev:** Uses `group-hover:opacity-100` with Tailwind (`TasksView.jsx:155-159`):
```jsx
<button className="opacity-0 group-hover:opacity-100 text-muted hover:text-danger transition-opacity p-0.5">
  <Trash2 size={14} />
</button>
```
Functionally similar but smaller icon (14px vs 24px container), no danger-subtle background on hover.

---

### 4.11 Priority Pill Styling

**main:** Custom CSS per priority (`dashboard.css:364-371`):
```css
.priority-pill { padding: 4px 10px; border-radius: var(--radius-full); font-size: 11px; }
.priority-high { color: var(--danger); border: 1px solid #ef444459; background: var(--danger-subtle); }
.priority-medium { color: var(--warn); border: 1px solid #f59e0b59; background: var(--warn-subtle); }
.priority-low { color: var(--ok); border: 1px solid #22c55e59; background: var(--ok-subtle); }
```
Each priority has a colored border + tinted background.

**dev:** Uses Badge component (`TasksView.jsx:172`):
```jsx
<Badge variant={PRIORITY_VARIANT[task.priority] || 'default'}>
```
Badge variants (`Badge.jsx`): `danger` → `bg-danger-subtle text-danger`, `warning` → `bg-warn-subtle text-warn`, `default` → `bg-secondary text-muted`.

Mapping: high → danger (close), medium → warning (close), low → default (loses green color — renders gray instead of green).

---

### 4.12 Empty Column Message

**main:** `dashboard.css:261`:
```css
.column-empty { color: var(--muted); font-size: 12px; text-align: center;
                padding: 24px 0; opacity: 0.5; }
```

**dev:** `TasksView.jsx:508`:
```jsx
<div className="text-xs text-muted text-center py-6">No tasks</div>
```
Similar but: `text-xs` = font-size 12px (matches). `py-6` = 24px (matches). Missing `opacity: 0.5`.

---

## 5. Visual & Layout Differences

### Column Dimensions

| Property | main | dev |
|----------|------|-----|
| Layout | CSS grid `repeat(4, 1fr)` | Flex, `min-w-[260px] max-w-[320px]` |
| Column count | 4 | 5 |
| Gap | 12px | 12px (`gap-3`) |
| Column padding | 12px | 0 (outer), 8px (body) |
| Column min-height | 200px | None |
| Column border-radius | `var(--radius-lg)` 12px | `rounded-xl` 16px |
| Column background | `var(--bg-accent)` | `bg-bg-surface` |

### Card Dimensions

| Property | main | dev |
|----------|------|-----|
| Padding | 12px | p-3 (12px) |
| Border-radius | `var(--radius-md)` 8px | `rounded-lg` 12px |
| Shadow | `shadow-sm` + inset highlight | None |
| Background | `var(--card)` #181b22 | `bg-bg-elevated` #1a1d25 |
| Min-width | 0 | Not set |
| Word-break | `break-word` | Not set (truncate on subtask title) |

### Typography

| Element | main | dev |
|---------|------|-----|
| Task ID | 11px, `var(--muted)`, no mono class | 11px, `text-muted`, `font-mono` |
| Task title | 13px, weight 500, `var(--text)` | `text-sm` 14px, `font-medium`, `text-primary` |
| Column title | 12px, uppercase, `var(--text)` | `text-xs` 12px, uppercase, `text-secondary` |
| Priority pill | 11px, weight 500 | 12px, weight 500 (Badge) |
| Progress text | 10px, mono, `var(--muted)` | 10px, mono, `text-muted` |

### Animations

| Animation | main | dev |
|-----------|------|-----|
| Card enter | `rise` 350ms (opacity + translateY) | None |
| Card delete | `shrink` 250ms (opacity + scale + collapse) | None |
| Popover open | `popIn` 120ms (opacity + translateY) | None |
| Modal overlay | `fadeIn` 150ms | None (instant) |
| Modal content | `modalIn` 200ms (scale + translateY) | None (instant) |
| Column drag-over | Border color + bg transition | N/A (no drag) |
| Expand chevron | `transform: rotate(90deg)` with `duration-fast` | `transition-transform duration-150` |

### Responsive Behavior

| Breakpoint | main | dev |
|------------|------|-----|
| > 900px | Grid 4-column | Flex 5-column, overflow scroll |
| ≤ 900px | Flex row, `scroll-snap-type: x mandatory`, columns 300px | Same flex, no snap |
| ≤ 600px | Columns 82vw, cards `min-height: 44px`, actions always visible | No adjustments |

---

## 6. State Management Differences

### Task State Tracking

| Aspect | main | dev |
|--------|------|-----|
| State container | `window.appState.tasks` (mutable array) | `window.appState.tasks` via `useAppState()` context |
| Module state | `kanbanState` object (exported) | React `useState` hooks |
| Edit tracking | `kanbanState.editingTaskId` | None |
| New card tracking | `kanbanState.newCardIds` (Set) | None |
| Adding task | `kanbanState.addingTask` (boolean) | `open` state inside AddTaskForm |
| Adding subtask | `kanbanState.addingSubtaskParentId` | None |
| Expanded parents | `kanbanState.expandedParents` (Set) | `expandedParents` useState (Set) |
| Sort direction | `kanbanState.sortNewestFirst` + localStorage | `sortNewestFirst` useState + localStorage |
| Archived toggle | N/A | `showArchived` useState + localStorage |
| Drag context | Module-level `draggedId` | None |
| Board built flag | `kanbanState.boardBuilt` | N/A (React handles mounting) |

### How State Changes Propagate

**main:** Direct DOM mutation + `window.appState` mutation. `updateBoard()` does diff-based DOM patching (checks existing cards vs new data, only adds/removes changed elements). Changes visible immediately.

**dev:** React re-renders triggered by `AppStateContext` fingerprint polling (500ms). The fingerprint hashes `viewedProject + activeProject + currentTab + tasks.map(t => t.id + t.status)`. This means: **priority changes are invisible to the fingerprint** — a priority-only update won't trigger re-render until the next full server poll overwrites `window.appState.tasks`.

### Sort/Filter Persistence

| Setting | main storage | dev storage |
|---------|-------------|-------------|
| Sort direction | `localStorage.sortNewestFirst` | `localStorage.sortNewestFirst` (same key) |
| Show archived | N/A | `localStorage.showArchived` |
| Expanded parents | Memory only (resets on refresh) | Memory only + syncs to `window.kanbanState` |

---

## 7. Interaction Pattern Mapping

### Click → Action Mapping

| User Action | main (kanban.js) | dev (TasksView.jsx) |
|-------------|-----------------|---------------------|
| Click task title | Inline edit (`startEdit`, :446) | Opens DetailPanel (`window.openTaskDetail`, :108) |
| Click subtask title | Inline edit (`startEditSubtask`, :463) | Opens DetailPanel (:78) |
| Click priority pill | Priority popover (`togglePriorityPopover`, :532) | Priority popover (generic `Popover`, :196) |
| Click status label | N/A (status via drag or subtask dot) | Status popover (generic `Popover`, :207) |
| Click subtask status dot | Status popover (`toggleStatusPopover`, :577) | Opens DetailPanel (whole card is clickable, :78) |
| Click delete button | Modal with subtask/spec checkboxes (`startDelete`, :660) | Modal with spec checkbox only (`DeleteTaskModal`, :264) |
| Click spec badge | Switch to files tab (`window._openSpec`) | N/A (no badge) |
| Click create-spec badge | POST spec, switch to files tab (`createSpec`, :754) | N/A (no badge) |
| Click subtask-add button | Inline form (`startAddSubtask`, :379) | N/A (no button) |
| Click add-task button | Inline form in "open" column (`startAdd`, :355) | Inline form in "backlog" column (AddTaskForm, :365) |
| Click expand chevron | Toggle subtask visibility (`toggleExpand`, :373) | Toggle subtask visibility (`handleToggleExpand`, :567) |
| Click sort toggle | Toggle + re-render (`toggleSort`, :24) | Toggle + re-render (`handleToggleSort`, :548) |
| Drag card to column | Optimistic status change (`onDrop`, :789) | N/A (no drag) |

### Keyboard Shortcuts

| Key | Context | main | dev |
|-----|---------|------|-----|
| Enter | Add-task input | Submit (`onAddKey`, :368) | Submit (`handleKeyDown`, :413) |
| Escape | Add-task input | Cancel (`onAddKey`, :369) | Cancel (`handleKeyDown`, :414) |
| Enter | Edit task title | Save (blur trigger, `onTitleKey`, :500) | N/A |
| Escape | Edit task title | Cancel (`onTitleKey`, :502) | N/A |
| Enter | Edit subtask title | Save (no shift, `onSubtaskTitleKey`, :487) | N/A |
| Shift+Enter | Edit subtask title | Newline | N/A |
| Escape | Edit subtask title | Cancel (`onSubtaskTitleKey`, :489) | N/A |
| Enter | Add-subtask input | Submit (keydown listener, :173) | N/A |
| Escape | Add-subtask input | Cancel (keydown listener, :174) | N/A |

### Touch/Mobile Considerations

**main:**
- Haptic feedback via `_h()` / `_hn()` on status change, create, delete, errors
- `e.preventDefault()` on toggle-sort touchstart (`passive: false`)
- `min-height: 44px` touch targets at 600px breakpoint
- `-webkit-overflow-scrolling: touch` for kanban scroll
- `scroll-snap-type: x mandatory` for column snapping

**dev:**
- Haptic feedback via `useHaptic()` hook on popover open, delete, create, errors
- No touch-specific event handlers
- No mobile touch-target sizing
- No scroll-snap
- No `-webkit-overflow-scrolling` property

---

## 8. Code Quality Notes

### Bugs in Dev

1. **Broken progress bar colors** (`TasksView.jsx:65-67`):
   - `bg-success` → NOT in `tailwind.config.js` (should be `bg-ok`)
   - `bg-warning` → NOT in `tailwind.config.js` (should be `bg-warn`)
   - Only `bg-info` resolves. Done and active segments are invisible.

2. **Double toast on delete**:
   - `DeleteTaskModal.handleConfirm()` shows `"Deleted T-xxx"` toast (`TasksView.jsx:275`)
   - `handleTaskDeleted()` callback also shows `"Deleted T-xxx"` toast (`TasksView.jsx:580`)
   - User sees two identical success toasts for one delete action.

3. **`onTaskCreated` is a no-op** (`TasksView.jsx:665`):
   ```jsx
   onTaskCreated={() => {}}
   ```
   After creating a task, the board relies entirely on poll refresh to show it. Combined with 5s server poll, there's a noticeable delay.

4. **Popover can clip off viewport** (`TasksView.jsx:348`):
   - Positioned at `top: anchorRect.bottom + 4, left: anchorRect.left`
   - No boundary detection. Cards near bottom or right edge will have popovers partially off-screen.

5. **Fingerprint ignores priority changes** (`AppStateContext.jsx`):
   ```js
   const tasksHash = s.tasks ? s.tasks.map(t => t.id + t.status).join(',') : '';
   ```
   Only hashes `id + status`. Priority changes won't trigger React re-render until the next full server poll.

### Dead Code

- `onTaskCreated={() => {}}` — wired up but does nothing (`TasksView.jsx:665`)
- `window.kanbanState` sync blocks may be dead if legacy kanban code is no longer loaded (`TasksView.jsx:553,562,573`)

### Accessibility Gaps

| Concern | main | dev |
|---------|------|-----|
| ARIA labels on interactive elements | None | `title` attributes only |
| Focus management after actions | Auto-focus on edit inputs | Auto-focus on add-task input |
| Keyboard navigation between cards | None | None |
| Screen reader: column structure | Implicit via DOM | Implicit via DOM |
| Role attributes | None | `data-react-tasks` test attr only |
| Focus trap in modals | None | None |
| Color-only information | Priority pills (but have text labels) | Same + status dots (color only, no text in subtask cards) |

### Performance Concerns

- No `React.memo` on `TaskCard`, `Column`, `SubtaskCard`, `SubtaskProgress` — every 500ms fingerprint poll re-renders all cards
- `allTasks.filter(t => t.parentId === task.id)` runs inside `SubtaskProgress` AND `ExpandedSubtasks` for every parent card on every render — O(n*m) where n=parents, m=total tasks
- No virtualization for large task boards (>100 tasks)
- `useMemo` on `grouped` recomputes only when `allTasks` or `sortNewestFirst` changes (good)

---

## 9. Recommended Fix Order

Ordered by dependency chain and impact.

### Phase 1 — Fix Bugs (trivial, do first)

1. **Fix progress bar Tailwind classes** — change `bg-success` → `bg-ok`, `bg-warning` → `bg-warn` in `TasksView.jsx:65-67`
2. **Fix double toast** — remove toast from `handleTaskDeleted` (`TasksView.jsx:580`) since `DeleteTaskModal` already shows it
3. **Fix priority pill "low" variant** — `PRIORITY_VARIANT.low` maps to `'default'` (gray) instead of green. Change to a variant that uses `ok` colors, or add a new Badge variant.

### Phase 2 — P0 Core Features (enables feature parity)

4. **Drag & drop** — add `draggable` to TaskCard, implement drag handlers on Column, optimistic status update with rollback. Depends on: nothing. Unblocks: cursor-grab styling (P2).
5. **Inline title editing** — add `editingTaskId` state, conditional input/textarea rendering, Enter/Escape/blur handlers, PUT API call. Depends on: nothing.
6. **Subtask creation** — add subtask-add button to TaskCard, `addingSubtaskParentId` state, inline AddSubtaskForm component, POST API call. Depends on: nothing.
7. **Spec file badges** — add spec badge rendering to TaskCard + SubtaskCard, wire open-spec and create-spec actions. Depends on: nothing.
8. **Delete modes** — extend DeleteTaskModal with subtask count awareness, add checkboxes, pass `mode` query param, handle parent cleanup in local state. Depends on: nothing.

### Phase 3 — P1 UX Polish (perceived quality)

9. **Optimistic updates** — for priority changes and status popover changes, update local state before API call, revert on failure. Also fix fingerprint to include priority. Depends on: #4 for drag-drop optimistic (already included there).
10. **Card animations** — add `rise` keyframe + `newCardIds` tracking for new cards, `shrink` keyframe for deletions. Depends on: #5 for delete animation flow.
11. **Priority popover redesign** — replace generic Popover with color-coded horizontal pill layout, add popIn animation, viewport boundary detection. Depends on: nothing.
12. **Subtask status popover** — make status dots interactive on SubtaskCard, add status popover, handle parentUpdated response. Depends on: nothing.
13. **Column layout** — switch to CSS grid or remove max-width cap so columns fill available space. Depends on: nothing.
14. **Wire `onTaskCreated`** — trigger `window.dispatchEvent(new CustomEvent('appstate:change'))` after task creation to force immediate React re-render. Depends on: nothing.

### Phase 4 — P2 Visual Polish

15. **Card shadow + inset highlight** — add `shadow-sm` + card-highlight shadow to TaskCard.
16. **Tree-line decoration system** — implement pseudo-element-based tree lines in subtask list (CSS or Tailwind arbitrary values). Depends on: #6 for subtask form tree-lines.
17. **Mobile responsive** — add scroll-snap, 82vw column widths at 600px, 44px min-height touch targets.
18. **Popover viewport clamping** — detect if popover would overflow viewport and flip/shift position.
19. **`React.memo`** — wrap TaskCard, Column, SubtaskCard in memo with appropriate comparators.
20. **Visual token alignment** — border-radius (8px not 12px for cards), cursor:grab, hover border+shadow, column bg/padding, empty state opacity.
