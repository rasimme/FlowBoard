#!/usr/bin/env bash
# install-hooks.sh — install FlowBoard hooks into ~/.openclaw/hooks/.
#
# Modes:
#   --symlink (default) — links the installed path to the repo checkout;
#                         future `git pull`s propagate automatically.
#   --copy              — copies files; must be re-run after repo updates.
#
# Safe to re-run: existing symlinks are replaced; existing regular directories
# get a `.bak-<timestamp>` backup before being overwritten.
#
# Usage:
#   scripts/install-hooks.sh                   # symlink (recommended)
#   scripts/install-hooks.sh --copy            # self-contained copy
#   OPENCLAW_HOME=/custom scripts/install-hooks.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
OPENCLAW_HOME="${OPENCLAW_HOME:-$HOME/.openclaw}"
HOOKS_DIR="$OPENCLAW_HOME/hooks"

MODE="symlink"
while [[ $# -gt 0 ]]; do
  case "$1" in
    --mode) MODE="$2"; shift 2 ;;
    --copy) MODE="copy"; shift ;;
    --symlink) MODE="symlink"; shift ;;
    -h|--help)
      sed -n '2,15p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) echo "Unknown argument: $1" >&2; exit 2 ;;
  esac
done

if [[ "$MODE" != "symlink" && "$MODE" != "copy" ]]; then
  echo "Invalid mode: $MODE (expected: symlink or copy)" >&2
  exit 2
fi

# FlowBoard ships two hooks; keep this list in sync if more are added.
HOOKS=(project-context session-handoff)

mkdir -p "$HOOKS_DIR"
echo "Installing FlowBoard hooks into $HOOKS_DIR (mode: $MODE)"
echo "Repo source: $REPO_ROOT/hooks"
echo

for hook in "${HOOKS[@]}"; do
  src="$REPO_ROOT/hooks/$hook"
  dst="$HOOKS_DIR/$hook"

  if [[ ! -d "$src" ]]; then
    echo "  ⚠  $hook: source missing ($src) — skipped"
    continue
  fi

  # Back up or remove whatever is at the destination so we can replace it cleanly.
  if [[ -L "$dst" ]]; then
    # Symlink: safe to remove (contents are in the repo)
    rm "$dst"
  elif [[ -e "$dst" ]]; then
    # Regular directory or file: back it up so we never lose local edits
    ts="$(date -u +"%Y-%m-%dT%H-%M-%S")"
    bak="$dst.bak-$ts"
    mv "$dst" "$bak"
    echo "  📦  $hook: existing install backed up to $bak"
  fi

  case "$MODE" in
    symlink)
      ln -s "$src" "$dst"
      echo "  ✓  $hook: symlinked → $src"
      ;;
    copy)
      cp -r "$src" "$dst"
      echo "  ✓  $hook: copied from $src"
      ;;
  esac
done

echo
echo "Hooks now installed:"
ls -la "$HOOKS_DIR" | sed 's|^|  |'
echo
echo "Next: restart the OpenClaw gateway so it re-loads hook handlers."
echo "      openclaw gateway restart"
