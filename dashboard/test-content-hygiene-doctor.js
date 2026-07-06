'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const doctor = require('./content-hygiene-doctor.js');

let passed = 0;
let failed = 0;

function ok(cond, msg) {
  if (cond) { passed++; console.log(`  ✅ ${msg}`); }
  else { failed++; console.error(`  ❌ ${msg}`); }
}

function section(name) { console.log(`\n## ${name}`); }

section('scanText()');
{
  const findings = doctor.scanText([
    'Natürlicher Content bleibt Unicode.',
    'Korrektes Unicode bleibt Ä, Ö und Ü.',
    'Dogfooding zeigte Pruefung, fuer und Koerperschaftsteuer.',
    'Mojibake sieht aus wie Ã¼, Ã¶, ÃŸ, Ã„, Ã–, Ãœ, Â© oder â€œ.',
    '`fuer` inside inline code is ignored.',
    '```',
    'waere inside fenced code is ignored',
    '```',
    'https://example.test/fuer-einen-slug',
    'feature-slug-fuer-technical-id',
  ].join('\n'), { source: 'fixture.md' });

  ok(findings.some(f => f.type === 'ascii-transliteration' && f.match === 'Pruefung'), 'reports suspicious German-style ASCII transliteration');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Ã¼'), 'reports mojibake');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Ã¶'), 'reports common mojibake for ö');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'ÃŸ'), 'reports common mojibake for ß');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Ã„'), 'reports common mojibake for Ä');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Ã–'), 'reports common mojibake for Ö');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Ãœ'), 'reports common mojibake for Ü');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'Â©'), 'reports common mojibake for ©');
  ok(findings.some(f => f.type === 'mojibake' && f.match === 'â€œ'), 'reports common mojibake for opening quote');
  ok(!findings.some(f => /Korrektes Unicode/.test(f.excerpt)), 'does not flag correct uppercase Unicode umlauts');
  ok(!findings.some(f => /inline code/.test(f.excerpt)), 'ignores inline code');
  ok(!findings.some(f => /fenced code/.test(f.excerpt)), 'ignores fenced code');
  ok(!findings.some(f => /example\.test/.test(f.excerpt)), 'ignores URLs');
  ok(!findings.some(f => /technical-id/.test(f.excerpt)), 'ignores slug-like technical lines');
}

section('scanTasks()');
{
  const findings = doctor.scanTasks([
    { id: 'T-1', title: 'Gefuehrte Anlage pruefen', description: 'Loehne und Gehaelter waeren relevant.' },
    { id: 'T-2', title: 'Clean Unicode: Prüfung läuft', description: 'Beschreibung mit Umlauten.' },
  ]);
  ok(findings.some(f => f.source === 'tasks:T-1:title'), 'reports task title findings with task id source');
  ok(findings.some(f => f.source === 'tasks:T-1:description'), 'reports task description findings with task id source');
  ok(!findings.some(f => f.source.startsWith('tasks:T-2')), 'does not flag correct Unicode content');
}

section('scanFiles()');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-content-hygiene-'));
  try {
    fs.mkdirSync(path.join(tmp, 'specs'), { recursive: true });
    fs.writeFileSync(path.join(tmp, 'PROJECT.md'), '# Projekt\n\nPruefung fuer Inhalte.\n');
    fs.writeFileSync(path.join(tmp, 'specs', 'T-1.md'), '# Spec\n\nMojibake: Ã¶\n');
    fs.writeFileSync(path.join(tmp, 'skip.txt'), 'fuer should not matter here\n');
    const findings = doctor.scanFiles(tmp);
    ok(findings.some(f => f.source === 'PROJECT.md'), 'scans markdown project files');
    ok(findings.some(f => f.source === path.join('specs', 'T-1.md')), 'scans nested markdown spec files');
    ok(!findings.some(f => f.source === 'skip.txt'), 'ignores non-markdown files');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

section('runCli()');
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'flowboard-content-hygiene-cli-'));
  const tasksJson = path.join(tmp, 'tasks.json');
  fs.writeFileSync(tasksJson, JSON.stringify({ tasks: [{ id: 'T-9', title: 'Pruefung' }] }));
  let out = '';
  const code = doctor.runCli(['--root', tmp, '--tasks-json', tasksJson], {
    stdout: { write: s => { out += s; } },
  });
  ok(code === 2, 'CLI exits 2 when findings exist');
  ok(out.includes('tasks.json:T-9:title'), 'CLI includes task findings');
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log(`\n=== ${passed} passed, ${failed} failed ===`);
process.exit(failed > 0 ? 1 : 0);
