#!/usr/bin/env node
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const versions = process.argv.slice(2).filter(arg => !arg.startsWith('--'));
const selectedVersions = versions.length > 0 ? versions : ['5.0.0', '5.0.1', '5.0.2', '5.0.3'];
const keepTemp = process.argv.includes('--keep-temp');
const packageName = process.env.FLOWBOARD_CLAWHUB_PACKAGE || 'flowboard';
const tmp = mkdtempSync(path.join(tmpdir(), 'flowboard-clawhub-scan-'));

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: options.cwd || process.cwd(),
    encoding: 'utf8',
    stdio: options.stdio || 'pipe',
    shell: false
  });
  if (result.error) throw new Error(`${command} ${args.join(' ')} failed: ${result.error.message}`);
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout;
}

function clawhubCommand() {
  if (process.env.FLOWBOARD_CLAWHUB_CLI) return process.env.FLOWBOARD_CLAWHUB_CLI;
  const probe = spawnSync('clawhub', ['--cli-version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], shell: false });
  if (!probe.error && probe.status === 0) return 'clawhub';
  if (process.env.HOME) return path.join(process.env.HOME, '.npm-global', 'bin', 'clawhub');
  return 'clawhub';
}

function zipJson(zipPath, file) {
  const raw = run('unzip', ['-p', zipPath, file]);
  return JSON.parse(raw);
}

function phaseForIssue(issue) {
  const file = issue.file || '';
  const id = issue.issueId || '';
  const text = `${file} ${id} ${issue.explanation || ''}`.toLowerCase();
  if (file === 'dashboard/file-visibility.js' || text.includes('file visibility')) return 'phase-1-file-visibility';
  if (text.includes('dangerouslysetinnerhtml') || text.includes('notecard') || text.includes('rendernotemarkdown') || id === 'OH1') return 'phase-6-output-rendering';
  if (text.includes('trigger') || text.includes('natural-language') || text.includes('brainstorm') || text.includes('legacy/project-rules')) return 'phase-2-trigger-docs';
  if (text.includes('agentid') || text.includes('agent identity') || id.startsWith('RA')) return 'phase-3-actor-auth';
  if (text.includes('self-update') || text.includes('/api/update/run')) return 'phase-4-self-update';
  if (text.includes('github token') || text.includes('access token') || id === 'PE3') return 'phase-5-github-token';
  return 'unmapped';
}

function summarize(version) {
  const clawhub = clawhubCommand();
  const zipPath = path.join(tmp, `${packageName}-${version}-scan.zip`);
  run(clawhub, ['scan', 'download', packageName, '--kind', 'plugin', '--version', version, '--output', zipPath]);
  const clawscanRaw = zipJson(zipPath, 'clawscan.json');
  const skillspectorRaw = zipJson(zipPath, 'skillspector.json');
  const clawscan = clawscanRaw || {};
  const skillspector = skillspectorRaw || {};
  const staticScan = zipJson(zipPath, 'static-analysis.json') || {};
  const vt = zipJson(zipPath, 'virustotal.json') || {};
  // A freshly-published version may still be mid-scan: clawscan/skillspector
  // come back as JSON null until the verdict/LLM pass completes. Report that as
  // `pending` instead of crashing on a null read.
  const pending = clawscanRaw === null || skillspectorRaw === null;
  const issues = skillspector.issues || [];
  const phaseCounts = {};
  const issueCounts = {};
  for (const issue of issues) {
    const phase = phaseForIssue(issue);
    phaseCounts[phase] = (phaseCounts[phase] || 0) + 1;
    const key = issue.issueId || 'unknown';
    issueCounts[key] = (issueCounts[key] || 0) + 1;
  }
  return {
    version,
    pending,
    clawscan: {
      status: clawscan.status,
      verdict: clawscan.verdict,
      confidence: clawscan.confidence,
      concernDimensions: (clawscan.dimensions || []).filter(d => d.rating === 'concern').map(d => d.name)
    },
    skillspector: {
      status: skillspector.status,
      severity: skillspector.severity,
      issueCount: skillspector.issueCount ?? issues.length,
      issueCounts,
      phaseCounts
    },
    staticScan: {
      status: staticScan.status,
      findings: (staticScan.findings || []).length,
      reasonCodes: staticScan.reasonCodes || []
    },
    virustotal: {
      status: vt.status,
      engineStats: vt.engineStats || null
    }
  };
}

try {
  const summaries = selectedVersions.map(summarize);
  console.log(JSON.stringify({ package: packageName, generatedAt: new Date().toISOString(), summaries }, null, 2));
} finally {
  if (keepTemp) console.error(`kept scan temp dir: ${tmp}`);
  else rmSync(tmp, { recursive: true, force: true });
}
