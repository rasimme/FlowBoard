# Use FlowBoard on a phone or in Telegram

The dashboard is touch- and phone-friendly. The same URL adapts to small screens; you can also open it as a Telegram Mini App for quick access on the go.

## Touch gestures on the board

- **Move a card:** press and hold its drag grip, then drag. Dragging near the top/bottom or left/right edge **auto-scrolls** the board or column so you can reach far columns.
- **Open a card:** tap it. On a phone the detail opens as a **full-screen sheet**; use the back control to return to the board.
- **Reorder within a column:** drag a card up or down; the new order sticks (in the *Custom* sort mode).

## Files on a phone

The Files page becomes a **master-detail** view: you see the list first, tap a file to open its full-screen preview/editor, and use **“← Files”** to go back. It doesn't auto-open a file on load, so you always start on the list.

## Idea Canvas gestures

- **One finger:** pan the canvas, or drag a note.
- **Two fingers:** pinch to zoom.
- **Double-tap** empty space: create a note.
- **Long-press** a note: open it for editing.

## Telegram Mini App

You can reach FlowBoard remotely as a Telegram Mini App through a secure tunnel:

1. Set up a tunnel and authentication as described in the README under [Remote Access](../../../README.md#remote-access-telegram-mini-app) (Cloudflare Tunnel, a bot token, `JWT_SECRET`, and your allowed user id).
2. Register the dashboard URL as your bot's menu button via `@BotFather`.
3. Open it from Telegram. Authentication uses Telegram's signed init-data (HMAC-SHA256); supported actions give light haptic feedback.

Opened outside Telegram, the Mini App URL shows an "open via Telegram" notice — that's expected; use the normal `http://localhost:18790` (or your tunnel URL in a browser) instead.

## See also

- [Getting started](../getting-started.md)
- [Search and filter tasks](search-and-filter.md)
