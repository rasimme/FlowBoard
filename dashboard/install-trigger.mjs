#!/usr/bin/env node
/**
 * install-trigger.mjs — install the FlowBoard external-agent trigger
 * snippet into a project repo.
 *
 * Adds (or refreshes) the snippet from `snippets/external-trigger.md`
 * inside `<repo>/AGENTS.md`, wrapped in idempotent markers so re-running
 * replaces the block instead of duplicating it. Then makes the same
 * content visible to Claude Code by setting up `<repo>/CLAUDE.md` as a
 * symlink to `AGENTS.md` — falls back to a plain copy if the filesystem
 * does not support symlinks (Windows, sync mounts, etc.). T-179-3.
 *
 * Usage:
 *   node install-trigger.mjs --repo /path/to/repo
 *   node install-trigger.mjs --repo /path/to/repo --no-symlink
 *   node install-trigger.mjs --repo /path/to/repo --uninstall
 *
 * Idempotent. Backups every file it modifies as <file>.bak-<timestamp>.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNIPPET_PATH = path.resolve(__dirname, '..', 'snippets', 'external-trigger.md');
const MARKER_START = '<!-- BEGIN FlowBoard external trigger -->';
const MARKER_END = '<!-- END FlowBoard external trigger -->';

function parseArgs(argv) {
  const args = { repo: null, noSymlink: false, uninstall: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') { args.repo = argv[++i]; }
    else if (a === '--no-symlink') { args.noSymlink = true; }
    else if (a === '--uninstall') { args.uninstall = true; }
    else if (a === '-h' || a === '--help') { args.help = true; }
  }
  return args;
}

function printHelp() {
  console.log(`Usage: node install-trigger.mjs --repo <path> [--no-symlink] [--uninstall]

Installs the FlowBoard external-agent trigger snippet into <repo>/AGENTS.md
and (by default) symlinks <repo>/CLAUDE.md -> AGENTS.md so Claude Code reads
it too. Idempotent: safe to re-run after the snippet evolves.

  --repo <path>    target repository directory (required)
  --no-symlink     do not create or update CLAUDE.md; copy AGENTS.md content
                   into CLAUDE.md instead (use on filesystems without symlinks)
  --uninstall      remove the FlowBoard block from AGENTS.md (and CLAUDE.md
                   if it is a symlink to AGENTS.md). Other content is kept.
  -h, --help       show this help`);
}

function backup(file) {
  if (!fs.existsSync(file)) return null;
  const bak = `${file}.bak-${Date.now()}`;
  fs.copyFileSync(file, bak);
  return bak;
}

function readOrEmpty(file) {
  try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
}

/**
 * Wrap the source snippet with idempotency markers at install time.
 * The source file intentionally stays marker-free so /api/info exposes only
 * the minimal agent instructions, while installed AGENTS.md files remain
 * safely replaceable/uninstallable across repeated installer runs.
 */
function buildMarkedBlock(snippet) {
  return `${MARKER_START}\n${snippet.trimEnd()}\n${MARKER_END}`;
}

/**
 * Replace or append the snippet block in `existing`. If a marker block
 * already exists, replace it; otherwise append at the end.
 */
function upsertBlock(existing, snippet) {
  const block = buildMarkedBlock(snippet);
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx >= 0 && endIdx > startIdx) {
    const before = existing.slice(0, startIdx).replace(/\s+$/, '');
    const after = existing.slice(endIdx + MARKER_END.length).replace(/^\s+/, '');
    const sep1 = before ? '\n\n' : '';
    const sep2 = after ? '\n\n' : '\n';
    return before + sep1 + block + sep2 + after;
  }
  // Append
  if (existing.trim().length === 0) return block + '\n';
  return existing.replace(/\s+$/, '') + '\n\n' + block + '\n';
}

function removeBlock(existing) {
  const startIdx = existing.indexOf(MARKER_START);
  const endIdx = existing.indexOf(MARKER_END);
  if (startIdx < 0 || endIdx < startIdx) return existing;
  const before = existing.slice(0, startIdx).replace(/\s+$/, '');
  const after = existing.slice(endIdx + MARKER_END.length).replace(/^\s+/, '');
  const sep = before && after ? '\n\n' : (before || after) ? '\n' : '';
  return before + sep + after;
}

function setupClaudeMd(claudePath, agentsPath, agentsContent, useSymlink) {
  // If CLAUDE.md exists and is NOT a symlink owned by us, leave it alone.
  let existingIsSymlink = false;
  try { existingIsSymlink = fs.lstatSync(claudePath).isSymbolicLink(); } catch {}
  if (fs.existsSync(claudePath) && !existingIsSymlink) {
    const existing = readOrEmpty(claudePath);
    if (!existing.includes(MARKER_START)) {
      console.warn(`! ${claudePath} exists, is not a symlink, and has no FlowBoard block.`);
      console.warn(`  Leaving it alone — your existing CLAUDE.md may not be visible to Claude Code with the FlowBoard snippet.`);
      console.warn(`  To install: either delete it, or pass --no-symlink to merge our block into it.`);
      return false;
    }
    // CLAUDE.md is a regular file we previously installed via --no-symlink.
    // Update it in place.
    backup(claudePath);
    fs.writeFileSync(claudePath, upsertBlock(existing, fs.readFileSync(SNIPPET_PATH, 'utf8')));
    console.log(`✓ Updated ${claudePath} (copy mode — already a regular file)`);
    return true;
  }

  if (useSymlink) {
    try {
      try { fs.unlinkSync(claudePath); } catch {}
      fs.symlinkSync('AGENTS.md', claudePath);
      console.log(`✓ ${claudePath} → AGENTS.md (symlink)`);
      return true;
    } catch (e) {
      console.warn(`! Symlink failed (${e.message}); falling back to copy.`);
      // fall through to copy
    }
  }

  backup(claudePath);
  fs.writeFileSync(claudePath, agentsContent);
  console.log(`✓ ${claudePath} (copy of AGENTS.md)`);
  return true;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !args.repo) {
    printHelp();
    process.exit(args.help ? 0 : 2);
  }

  const repo = path.resolve(args.repo);
  if (!fs.existsSync(repo) || !fs.statSync(repo).isDirectory()) {
    console.error(`! Not a directory: ${repo}`);
    process.exit(2);
  }

  const agentsPath = path.join(repo, 'AGENTS.md');
  const claudePath = path.join(repo, 'CLAUDE.md');

  if (args.uninstall) {
    const existing = readOrEmpty(agentsPath);
    if (!existing.includes(MARKER_START)) {
      console.log(`No FlowBoard block found in ${agentsPath} — nothing to remove.`);
    } else {
      backup(agentsPath);
      const updated = removeBlock(existing);
      if (updated.trim().length === 0) {
        fs.unlinkSync(agentsPath);
        console.log(`✓ ${agentsPath} removed (was empty after uninstall)`);
      } else {
        fs.writeFileSync(agentsPath, updated);
        console.log(`✓ Removed FlowBoard block from ${agentsPath}`);
      }
    }
    // Drop CLAUDE.md if it's a symlink to AGENTS.md
    try {
      const stat = fs.lstatSync(claudePath);
      if (stat.isSymbolicLink()) {
        const target = fs.readlinkSync(claudePath);
        if (target === 'AGENTS.md') {
          fs.unlinkSync(claudePath);
          console.log(`✓ Removed ${claudePath} symlink`);
        }
      }
    } catch {}
    return;
  }

  let snippet;
  try { snippet = fs.readFileSync(SNIPPET_PATH, 'utf8'); }
  catch (e) {
    console.error(`! Could not read ${SNIPPET_PATH}: ${e.message}`);
    process.exit(2);
  }

  // 1) AGENTS.md — install or refresh the block
  const existing = readOrEmpty(agentsPath);
  const updated = upsertBlock(existing, snippet);
  if (updated === existing) {
    console.log(`= ${agentsPath} already up to date`);
  } else {
    backup(agentsPath);
    fs.writeFileSync(agentsPath, updated);
    console.log(`✓ ${agentsPath} updated`);
  }

  // 2) CLAUDE.md — symlink (default) or copy
  const finalAgents = fs.readFileSync(agentsPath, 'utf8');
  setupClaudeMd(claudePath, agentsPath, finalAgents, !args.noSymlink);

  console.log('');
  console.log('Done. Restart your agent (Claude Code / Codex / Cursor) so it picks up the new instructions.');
  console.log(`Discovery URL: ${process.env.FLOWBOARD_API || 'http://localhost:18790'}/api/info`);
}

main();
