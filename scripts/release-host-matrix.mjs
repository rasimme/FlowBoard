#!/usr/bin/env node
/**
 * FlowBoard supported-host matrix runner (T-487-1).
 *
 * Runs `scripts/release-install-canary.mjs` once per OpenClaw CLI and prints
 * one table of host × step. A single canary proves FlowBoard installs on the
 * host you happen to have; this proves the *range* FlowBoard claims — the
 * hook-only baseline on 2026.6.6 through the feature layer on 2026.9.x — which
 * is the only thing that makes `openclaw.install.minHostVersion` a promise
 * rather than a guess.
 *
 * The artifact is packed once and reused for every host
 * (`FLOWBOARD_CANARY_ARTIFACT`), so all hosts see byte-identical bytes.
 *
 * Syntax — `FLOWBOARD_HOST_MATRIX` is a comma-separated list of entries:
 *
 *     <cli-path>
 *     node=<node-path> <cli-path>
 *     <label>: node=<node-path> <cli-path>
 *
 * The `node=` prefix is usually required: the OpenClaw bin is a
 * `#!/usr/bin/env node` script, so it runs on whatever `node` is first on
 * PATH, and the supported hosts disagree about Node (2026.9.x demands
 * >= 24.16, 2026.6.6 predates it). `FLOWBOARD_HOST_MATRIX_NODE` supplies a
 * default for entries without a prefix.
 *
 *     FLOWBOARD_HOST_MATRIX="\
 *       2026.6.6: node=/opt/node24/bin/node /opt/oc66/node_modules/.bin/openclaw,\
 *       2026.9.5: node=/opt/node2421/bin/node /opt/oc95/node_modules/.bin/openclaw" \
 *       node scripts/release-host-matrix.mjs
 *
 * Entries may also be passed as positional arguments, which override the env.
 * Exit code is non-zero if any host fails any required step.
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { runCli } from './lib/openclaw-host.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const CANARY = path.join(__dirname, 'release-install-canary.mjs');

const MARKS = { pass: 'ok', skip: '-', fail: 'FAIL' };

function usage() {
  console.log(
    [
      'Usage:',
      '  FLOWBOARD_HOST_MATRIX="<entry>[,<entry>...]" node scripts/release-host-matrix.mjs [--json]',
      '  node scripts/release-host-matrix.mjs [--json] <entry> [<entry>...]',
      '',
      'Entry:',
      '  <cli-path>                                 an openclaw CLI to test',
      '  node=<node-path> <cli-path>                run that CLI on that Node',
      '  <label>: node=<node-path> <cli-path>       give the column a name',
      '',
      'Env:',
      '  FLOWBOARD_HOST_MATRIX        comma-separated entries (see above)',
      '  FLOWBOARD_HOST_MATRIX_NODE   default Node for entries without a node= prefix',
      '  FLOWBOARD_CANARY_ARTIFACT    reuse an existing tarball instead of packing one',
      '',
      'Run `npm run build:plugin` first: the packed artifact must contain the',
      'generated Control UI bundle or the ≥ 2026.9.2 hosts cannot load the page.',
    ].join('\n'),
  );
}

/** Parse one matrix entry into `{ label, node, cli }`. */
export function parseMatrixEntry(raw, defaultNode = null) {
  let rest = String(raw).trim();
  if (!rest) return null;
  let label = null;
  const labelled = /^([^:]+):\s+(.*)$/.exec(rest);
  if (labelled && !labelled[1].includes('/')) {
    label = labelled[1].trim();
    rest = labelled[2].trim();
  }
  let node = defaultNode;
  const nodePrefix = /^node=(\S+)\s+(.*)$/.exec(rest);
  if (nodePrefix) {
    node = nodePrefix[1];
    rest = nodePrefix[2].trim();
  }
  if (!rest) return null;
  return { label: label || path.basename(rest), node, cli: rest };
}

export function parseMatrix(spec, defaultNode = null) {
  return String(spec || '')
    .split(',')
    .map((entry) => parseMatrixEntry(entry, defaultNode))
    .filter(Boolean);
}

function packOnce(tmp) {
  if (process.env.FLOWBOARD_CANARY_ARTIFACT) return process.env.FLOWBOARD_CANARY_ARTIFACT;
  const result = runCli('npm', ['pack', '--json', '--pack-destination', tmp], { cwd: root });
  if (!result.ok) throw new Error(`npm pack failed:\n${result.output}`);
  const filename = JSON.parse(result.stdout)[0]?.filename;
  if (!filename) throw new Error('npm pack did not return a filename');
  return path.join(tmp, filename);
}

function runHost(entry, artifact) {
  const env = {
    ...process.env,
    FLOWBOARD_OPENCLAW_CLI: entry.cli,
    FLOWBOARD_CANARY_ARTIFACT: artifact,
  };
  if (entry.node) env.FLOWBOARD_OPENCLAW_NODE = entry.node;
  else delete env.FLOWBOARD_OPENCLAW_NODE;

  const result = runCli(process.execPath, [CANARY, '--json'], { cwd: root, env });
  try {
    return { entry, report: JSON.parse(result.stdout), stderr: result.stderr };
  } catch {
    return {
      entry,
      report: {
        ok: false,
        host: { cli: entry.cli, version: null },
        steps: [{ id: 'canary', status: 'fail', detail: result.output.trim().split('\n').slice(-3).join(' | ') }],
      },
      stderr: result.stderr,
    };
  }
}

function renderTable(results) {
  const stepIds = [];
  for (const { report } of results) {
    for (const step of report.steps || []) if (!stepIds.includes(step.id)) stepIds.push(step.id);
  }
  const headers = ['step', ...results.map(({ entry, report }) => report.host?.version || entry.label)];
  const rows = stepIds.map((id) => [
    id,
    ...results.map(({ report }) => {
      const step = (report.steps || []).find((s) => s.id === id);
      return step ? MARKS[step.status] || step.status : '';
    }),
  ]);
  rows.push([
    'RESULT',
    ...results.map(({ report }) => (report.ok ? 'PASS' : 'FAIL')),
  ]);

  const widths = headers.map((header, index) =>
    Math.max(header.length, ...rows.map((row) => String(row[index] ?? '').length)),
  );
  const line = (cells) => cells.map((cell, i) => String(cell ?? '').padEnd(widths[i])).join('  ').trimEnd();

  const out = [line(headers), line(widths.map((width) => '-'.repeat(width)))];
  for (const row of rows) out.push(line(row));
  return out.join('\n');
}

// The parse helpers above are unit-tested
// (dashboard/test-openclaw-host-capabilities.mjs), so the CLI body only runs
// when this file is the entry point — importing it must not pack, spawn or exit.
function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    usage();
    process.exit(0);
  }
  const asJson = argv.includes('--json');
  const positional = argv.filter((arg) => !arg.startsWith('--'));

  const defaultNode = process.env.FLOWBOARD_HOST_MATRIX_NODE || null;
  const entries = positional.length
    ? positional.map((entry) => parseMatrixEntry(entry, defaultNode)).filter(Boolean)
    : parseMatrix(process.env.FLOWBOARD_HOST_MATRIX, defaultNode);

  if (entries.length === 0) {
    console.error('release host matrix failed: no hosts. Set FLOWBOARD_HOST_MATRIX or pass entries as arguments.\n');
    usage();
    process.exit(1);
  }

  for (const entry of entries) {
    if (entry.cli.includes(path.sep) && !existsSync(entry.cli)) {
      console.error(`release host matrix failed: CLI not found: ${entry.cli}`);
      process.exit(1);
    }
  }

  const tmp = mkdtempSync(path.join(tmpdir(), 'flowboard-host-matrix-'));
  let exitCode = 0;
  try {
    const artifact = packOnce(tmp);
    if (!asJson) console.log(`artifact: ${path.basename(artifact)}\n`);

    const results = [];
    for (const entry of entries) {
      if (!asJson) console.log(`running canary on ${entry.label} (${entry.cli})…`);
      results.push(runHost(entry, artifact));
    }
    exitCode = results.every(({ report }) => report.ok) ? 0 : 1;

    if (asJson) {
      console.log(
        JSON.stringify(
          {
            ok: exitCode === 0,
            artifact: path.basename(artifact),
            hosts: results.map(({ entry, report }) => ({ entry, report })),
          },
          null,
          2,
        ),
      );
    } else {
      console.log(`\n${renderTable(results)}\n`);
      for (const { entry, report } of results) {
        for (const step of report.steps || []) {
          if (step.status === 'fail') console.error(`${entry.label}: ${step.id} — ${step.detail}`);
        }
      }
      console.log(
        exitCode === 0 ? `release host matrix ok (${results.length} host(s))` : 'release host matrix FAILED',
      );
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
    process.exit(exitCode);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
