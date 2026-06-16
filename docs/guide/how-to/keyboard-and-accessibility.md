# Keyboard and accessibility

FlowBoard's board and sidebar are fully operable from the keyboard, with screen-reader announcements for the actions that matter.

## Open and navigate

- Cards are focusable. Move focus with `Tab`; press **`Enter`** or **`Space`** to open the focused card. (Cards are not buttons, so nested controls stay reachable.)
- The search palette (`Cmd/Ctrl+K`) is keyboard-first: arrow keys move through results, `Enter` opens.

## Reorder without a mouse

Both the Kanban cards and the sidebar project list support keyboard reordering:

1. Focus the item.
2. Press **`Space`** to pick it up.
3. Use the **arrow keys** to move it (within a column, across columns, or up/down the project list).
4. Press **`Space`** to drop it, or **`Esc`** to cancel.

Each step is announced via an ARIA live region, so screen-reader users hear the item's new position.

## See also

- [Work the Kanban board](work-the-kanban.md)
- [Use FlowBoard on a phone or in Telegram](work-on-mobile.md)
