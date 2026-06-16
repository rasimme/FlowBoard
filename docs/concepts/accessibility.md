# Accessibility

## What it is

The board and sidebar are operable without a mouse and announce their state to assistive technology — most notably full keyboard drag-and-drop with live-region feedback.

## Why it exists

Drag-and-drop is the board's primary interaction, and pointer-only DnD excludes keyboard and screen-reader users entirely. Rather than bolt on a separate "accessible mode," the keyboard path mirrors the pointer path so the same reordering is reachable both ways.

## How it works

- **Cards are not buttons.** A card is a focusable container with an `aria-label`; `Enter`/`Space` opens it. Making it a `role=button` would have swallowed the nested interactive controls — so the open action lives on the container without that role.
- **Keyboard reorder:** focus an item, `Space` to pick it up, arrow keys to move it (within a column, across columns, or up/down the sidebar project list), `Space` to drop, `Esc` to cancel.
- **Live announcements:** an `aria-live` (`role=status`) region narrates each step ("picked up", new position, "dropped") so non-visual users follow the move.
- The search palette is arrow-key navigable.

## Consequences

- New drag interactions must ship a keyboard equivalent and announce position changes — the pointer handler alone is not "done".
- There is currently **no automated a11y assertion** (e.g. axe) in the gate; accessibility is maintained by convention and review. That gap is worth a future drift/guard test.
- Documented for users in [Keyboard and accessibility](../guide/how-to/keyboard-and-accessibility.md) and the [shortcuts reference](../guide/reference/keyboard-shortcuts.md).

## Where the code lives

- `dashboard/src/pages/TasksView.jsx` — `handleCardKeyDown`, the `aria-live` status region, focusable cards.
- `dashboard/src/components/Sidebar.jsx` — keyboard project reorder.
