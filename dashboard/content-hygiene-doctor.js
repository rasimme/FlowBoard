'use strict';

const fs = require('fs');
const path = require('path');

const MOJIBAKE_RE = /(?:Ã[\u0080-\u00bf]|Â[\u0020-\u007e]|â(?:€|„|œ|€œ|€™|€“|€”|€¦)|�)/g;

const TRANSLITERATION_PATTERNS = [
  /\bfuer\b/gi,
  /\bwaer(?:e|en|st|t)?\b/gi,
  /\bpruef\w*\b/gi,
  /\bkoerper\w*\b/gi,
  /\bloehn\w*\b/gi,
  /\bgefuehr\w*\b/gi,
  /\bergaenz\w*\b/gi,
  /\berhaelt\w*\b/gi,
  /\bduerf\w*\b/gi,
  /\bmuess\w*\b/gi,
  /\bkoenn\w*\b/gi,
  /\boeff\w*\b/gi,
  /\bueber\w*\b/gi,
  /\bzurueck\w*\b/gi,
  /\bnaechst\w*\b/gi,
  /\bausfuehr\w*\b/gi,
];

function isSkippableLine(line) {
  const trimmed = line.trim();
  if (!trimmed) return true;
  if (/^#{1,6}\s+[-`A-Za-z0-9_./:]+$/.test(trimmed)) return true;
  if (/^[-*]\s+`[^`]+`/.test(trimmed)) return true;
  if (/^https?:\/\//i.test(trimmed) || /\bhttps?:\/\//i.test(trimmed)) return true;
  if (/^[\w./-]+$/.test(trimmed) && /[-_/]/.test(trimmed)) return true;
  if (/^[\s]*["'][A-Za-z0-9_.-]+["']\s*:/.test(line)) return true;
  return false;
}

function stripInlineCode(line) {
  return line.replace(/`[^`]*`/g, match => ' '.repeat(match.length));
}

function excerpt(line, index, length) {
  const start = Math.max(0, index - 24);
  const end = Math.min(line.length, index + length + 24);
  return line.slice(start, end).trim();
}

function pushRegexFindings(findings, re, text, lineNo, line, type) {
  re.lastIndex = 0;
  let match;
  while ((match = re.exec(text))) {
    findings.push({
      type,
      line: lineNo,
      column: match.index + 1,
      match: match[0],
      excerpt: excerpt(line, match.index, match[0].length),
    });
  }
}

function scanText(content, options = {}) {
  const findings = [];
  const source = options.source || '<text>';
  const lines = String(content || '').split(/\r?\n/);
  let inFence = false;

  lines.forEach((line, idx) => {
    const lineNo = idx + 1;
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      return;
    }
    if (inFence || isSkippableLine(line)) return;

    const searchable = stripInlineCode(line);
    pushRegexFindings(findings, MOJIBAKE_RE, searchable, lineNo, line, 'mojibake');
    for (const pattern of TRANSLITERATION_PATTERNS) {
      pushRegexFindings(findings, pattern, searchable, lineNo, line, 'ascii-transliteration');
    }
  });

  return findings.map(f => ({ source, ...f }));
}

function scanMarkdownFile(filePath, options = {}) {
  const content = fs.readFileSync(filePath, 'utf8');
  return scanText(content, { source: options.source || filePath });
}

function walkMarkdownFiles(root) {
  const out = [];
  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  }
  walk(root);
  return out;
}

function scanFiles(root) {
  const base = path.resolve(root);
  return walkMarkdownFiles(base).flatMap(file => {
    const rel = path.relative(base, file) || path.basename(file);
    return scanMarkdownFile(file, { source: rel });
  });
}

function scanTasks(tasks, options = {}) {
  const findings = [];
  for (const task of tasks || []) {
    const id = task?.id || task?.metadata?.flowboard?.id || task?.task_id || '<unknown>';
    if (task?.title) {
      findings.push(...scanText(task.title, { source: `${options.source || 'tasks'}:${id}:title` }));
    }
    if (task?.description) {
      findings.push(...scanText(task.description, { source: `${options.source || 'tasks'}:${id}:description` }));
    }
  }
  return findings;
}

function formatFindings(findings) {
  if (!findings.length) return 'content-hygiene: no suspicious content found\n';
  const lines = ['content-hygiene findings:'];
  for (const f of findings) {
    lines.push(`- ${f.source}:${f.line}:${f.column} [${f.type}] ${f.match} — ${f.excerpt}`);
  }
  return `${lines.join('\n')}\n`;
}

function parseArgs(argv) {
  const args = { root: process.cwd(), tasksJson: null };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--root') args.root = argv[++i];
    else if (arg === '--tasks-json') args.tasksJson = argv[++i];
    else if (arg === '--help' || arg === '-h') args.help = true;
  }
  return args;
}

function runCli(argv = process.argv.slice(2), io = process) {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write('Usage: node content-hygiene-doctor.js [--root <dir>] [--tasks-json <file>]\n');
    return 0;
  }
  let findings = scanFiles(args.root);
  if (args.tasksJson) {
    const parsed = JSON.parse(fs.readFileSync(args.tasksJson, 'utf8'));
    findings = findings.concat(scanTasks(parsed.tasks || parsed, { source: args.tasksJson }));
  }
  io.stdout.write(formatFindings(findings));
  return findings.length ? 2 : 0;
}

module.exports = {
  MOJIBAKE_RE,
  TRANSLITERATION_PATTERNS,
  scanText,
  scanMarkdownFile,
  scanFiles,
  scanTasks,
  formatFindings,
  parseArgs,
  runCli,
};

if (require.main === module) {
  process.exit(runCli());
}
