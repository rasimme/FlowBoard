# FlowBoard Design Guidelines

Reference for UI consistency with the OpenClaw Gateway Dashboard.

## Design System Origin

FlowBoard follows the **OpenClaw Gateway Dashboard** design language.
The Gateway uses a compiled SPA (control-ui) with Lucide icons, CSS custom properties,
and a dark-first approach. FlowBoard mirrors these patterns in vanilla CSS + JS modules.

## Typography

| Token | Value |
|-------|-------|
| `--font-body` | Space Grotesk, system fallbacks |
| `--mono` | JetBrains Mono, system monospace |
| Display weight | 600–700 |
| Body weight | 400–500 |
| Mono weight | 400–500 |

## Color Palette

### Core

| Token | Value | Usage |
|-------|-------|-------|
| `--bg` | `#12141a` | Page background |
| `--bg-elevated` | `#1a1d25` | Raised surfaces |
| `--bg-hover` | `#262a35` | Hover states |
| `--card` | `#181b22` | Card backgrounds |
| `--text` | `#e4e4e7` | Primary text |
| `--text-strong` | `#fafafa` | Headings, emphasis |
| `--muted` | `#71717a` | Secondary text, icons |
| `--border` | `#27272a` | Default borders |
| `--border-strong` | `#3f3f46` | Hover borders |

### Accent

| Token | Value | Usage |
|-------|-------|-------|
| `--accent` | `#ff5c5c` | Primary accent (OpenClaw red) |
| `--accent-hover` | `#ff7070` | Accent hover |
| `--accent-subtle` | `rgba(255, 92, 92, 0.15)` | Accent backgrounds |
| `--accent-2` | `#14b8a6` | Secondary accent (teal) |

### Semantic

| Token | Value | Usage |
|-------|-------|-------|
| `--ok` | `#22c55e` | Success, low priority |
| `--ok-subtle` | `rgba(34, 197, 94, 0.12)` | Success backgrounds |
| `--warn` | `#f59e0b` | Warning, medium priority |
| `--warn-subtle` | `rgba(245, 158, 11, 0.12)` | Warning backgrounds |
| `--danger` | `#ef4444` | Error, high priority |
| `--danger-subtle` | `rgba(239, 68, 68, 0.12)` | Error backgrounds |
| `--info` | `#3b82f6` | Info states |

## Border Radius

| Token | Value | Usage |
|-------|-------|-------|
| `--radius-sm` | `6px` | Small elements (pills, badges) |
| `--radius` / `--radius-md` | `8px` | Default (cards, inputs) |
| `--radius-lg` | `12px` | Large containers |
| `--radius-full` | `9999px` | Fully rounded (pills, dots) |

## Icons

**Library:** Lucide (https://lucide.dev)
**Style:** Stroke-based, consistent with Gateway Dashboard.

| Property | Value |
|----------|-------|
| ViewBox | `0 0 24 24` |
| Render size | 14–18px (context-dependent) |
| Fill | `none` |
| Stroke | `currentColor` |
| Stroke width | `1.5px` |
| Stroke linecap | `round` |
| Stroke linejoin | `round` |

### Icon Template
```html
<svg width="14" height="14" viewBox="0 0 24 24" fill="none"
  stroke="currentColor" stroke-width="1.5"
  stroke-linecap="round" stroke-linejoin="round">
  <path d="..."/>
</svg>
```

### Icons in Use
- **Delete:** Trash icon (14px, in task cards)
- **Spec file:** File-text icon (14px, in task meta)
- **Add spec:** File-plus icon (14px, ghost on hover)

## Buttons

### Standard Button
```css
padding: 6px 10px; /* btn-sm */
font-size: 11px;
border-radius: var(--radius);
```

### Icon Button (Gateway: `.btn--icon`)
```css
width: 26–36px; height: 26–36px;
display: inline-flex; align-items: center; justify-content: center;
border: 1px solid var(--border);
background: #ffffff0f;
border-radius: var(--radius-sm);
```
Hover: `background: #ffffff1f; border-color: var(--border-strong);`

### Ghost Button
Default state: transparent, invisible.
Hover: subtle border + background fade-in.
Used for: add actions on cards (appears on parent hover).

## Cards

```css
background: var(--card);
border: 1px solid var(--border);
border-radius: var(--radius);
```
Hover: `border-color: var(--border-strong);`

## Pills / Badges

```css
padding: 4px 10px;
border-radius: var(--radius-full);
font-size: 11px;
font-weight: 500;
```
Use semantic colors for priority pills (`--ok`, `--warn`, `--danger` + subtle bg).

## Interaction Patterns

### Hover
- Cards: border-color transition to `--border-strong`
- Buttons: background shift (`#ffffff0f` → `#ffffff1f`)
- Ghost elements: opacity fade-in (0 → 0.5 → 1)
- Transitions: `var(--duration-fast)` (150ms)

### Popovers
```css
position: absolute;
width: max-content;
background: var(--card);
border: 1px solid var(--border);
border-radius: var(--radius);
box-shadow: 0 12px 28px rgba(0,0,0,.35);
z-index: 100;
animation: popIn var(--duration-fast);
```

### Toasts
Position: bottom-right. Auto-dismiss after 3s.
Types: info (default), success (green), error (red).

## Scrollbars

Custom scrollbar implementation (`.cscroll-*` classes).
Track: transparent. Thumb: `var(--border)`, hover: `var(--border-strong)`.
Width: 8px. Border-radius: full.

## Responsive

Breakpoint: `900px`
- Below: collapse project sidebar, hide file tree
- Single-column layout for mobile

## Language

**All UI text in English** — labels, buttons, toasts, placeholders, tab names.
Project content (tasks, specs, docs) can be in any language.

---

*Based on OpenClaw Gateway Dashboard (control-ui), analyzed 2026-02-19.*
