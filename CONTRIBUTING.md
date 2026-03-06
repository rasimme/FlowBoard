# Contributing

Thanks for helping improve FlowBoard.

## Development workflow

- Default branch: `main`
- Development branch: **`dev`**
- Please create feature branches off `dev`:

```bash
git checkout dev
git pull
git checkout -b feat/my-change
```

## Running locally

```bash
cd dashboard
npm install
node server.js
```

## Code style

- Vanilla JS (ES modules), no build step
- Keep modules small and cohesive
- Avoid introducing dependencies unless there is a clear win

## Pull requests

- Keep PRs focused (one topic)
- Include screenshots for UI changes
- Mention platform tested (desktop/mobile)
