#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';

const TEXT_EXTENSIONS = new Set([
  '.css', '.env', '.example', '.html', '.js', '.json', '.jsx', '.md', '.mjs',
  '.sh', '.txt', '.ts', '.tsx', '.yml', '.yaml'
]);

const SECRET_ASSIGNMENT = /^[ \t]*(?:export[ \t]+)?(?:TELEGRAM_BOT_TOKEN|BOT_TOKEN|JWT_SECRET|OPENCLAW_HOOKS_TOKEN|HOOKS_TOKEN|INTEGRITY_WEBHOOK_TOKEN)[ \t]*=[ \t]*["']?([^"'\s#]*)["']?/gmi;

const ALLOWED_PLACEHOLDER_VALUES = new Set([
  '',
  '<secret>',
  '<token>',
  '<your-secret>',
  '<your-token>',
  'changeme',
  'example',
  'placeholder',
  'your-random-secret-string',
  'your-secret',
  'your-secret-token',
  'your-telegram-bot-token',
  '$(openssl'
]);

const BLOCKED_PATTERNS = [
  { name: 'private hostname', pattern: /simme-ns5\.com/i },
  { name: 'telegram user id', pattern: /\b15707748\b/ },
  { name: 'local user path', pattern: /\/Users\/simeon(?:\.ortmueller)?\b/ },
  { name: 'local username/email fragment', pattern: /\bsimeon\.ortmueller\b/i },
  // T-288-9: the bare first name slipped into shipped sample data once —
  // catch it standalone too (case-insensitive, word-bounded).
  { name: 'operator first name', pattern: /\bsimeons?\b/i }
];

function gitFiles() {
  const output = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], {
    encoding: 'utf8'
  });
  return output.split('\n').filter(Boolean);
}

function extensionOf(path) {
  const match = path.match(/(\.[^./]+)$/);
  return match?.[1] || '';
}

function shouldScan(path) {
  // The scanner itself must hold the blocked patterns as literals.
  if (path === 'scripts/privacy-scan.mjs') return false;
  if (path.includes('/node_modules/') || path.includes('/dist/')) return false;
  if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || path.endsWith('.gif') || path.endsWith('.ico') || path.endsWith('.svg')) return path.endsWith('.svg');
  if (path.endsWith('package-lock.json') || path.endsWith('pnpm-lock.yaml')) return false;
  return TEXT_EXTENSIONS.has(extensionOf(path)) || path.includes('.env');
}

function lineNumber(content, index) {
  return content.slice(0, index).split('\n').length;
}

const findings = [];

for (const file of gitFiles().filter(shouldScan)) {
  let content;
  try {
    content = readFileSync(file, 'utf8');
  } catch {
    continue;
  }

  for (const rule of BLOCKED_PATTERNS) {
    const match = rule.pattern.exec(content);
    if (match) {
      findings.push(`${file}:${lineNumber(content, match.index)} ${rule.name}`);
    }
    rule.pattern.lastIndex = 0;
  }

  for (const match of content.matchAll(SECRET_ASSIGNMENT)) {
    const value = String(match[1] || '').trim();
    const normalized = value.toLowerCase();
    if (
      !ALLOWED_PLACEHOLDER_VALUES.has(normalized)
      && !normalized.startsWith('<')
      && !normalized.includes('placeholder')
      && !normalized.startsWith('$(')
    ) {
      findings.push(`${file}:${lineNumber(content, match.index)} non-placeholder secret value`);
    }
  }
}

// T-288-1: the npm `files` allowlist overrides .gitignore, so the published
// tarball can ship files git never tracked (local plans, test residue,
// SQLite WAL). Dry-run the pack and reject forbidden paths.
const FORBIDDEN_PACK_PATHS = [
  /^docs\/plans\//,
  /^docs\/reviews\//,
  /^dashboard\/projects\//,
  /^dashboard\/test-workspace/,
  /^dashboard\/test-/,
  /^SECURITY-REVIEW\.md$/,
  /\.db(-wal|-shm)?$/,
  /\/\.hzl\//
];

try {
  const packJson = execFileSync('npm', ['pack', '--dry-run', '--json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  const packed = JSON.parse(packJson)[0]?.files || [];
  for (const entry of packed) {
    if (FORBIDDEN_PACK_PATHS.some(p => p.test(entry.path))) {
      findings.push(`npm-pack would ship forbidden path: ${entry.path}`);
    }
  }
} catch (err) {
  findings.push(`npm pack --dry-run failed: ${err.message}`);
}

if (findings.length > 0) {
  console.error('Privacy scan failed:');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log('privacy scan ok');
